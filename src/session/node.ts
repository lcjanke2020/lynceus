import CDP from "chrome-remote-interface";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sessionState } from "./state.js";
import { connectDebugger } from "./debugger.js";
import { alreadySession, ToolError } from "../util/errors.js";
import { log } from "../util/log.js";

export interface AttachNodeArgs {
  host?: string;
  port?: number;
}

export interface LaunchNodeArgs {
  script: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inspectMode?: "inspect" | "inspect-brk";
  inspectPort?: number;
}

const DEFAULT_NODE_INSPECTOR_PORT = 9229;
const DEFAULT_NODE_INSPECTOR_HOST = "127.0.0.1";
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const OUTPUT_SNIPPET_LIMIT = 8_192;
const LISTENING_RE = /^Debugger listening on ws:\/\/[^:]+:(\d+)\//m;

// Attach to an already-running Node.js process started with --inspect or
// --inspect-brk. Mirrors attach_chrome's "we did NOT launch the process"
// posture — closing this session does NOT kill the Node process.
//
// Differs from connectToTarget (the browser path) in three ways, all
// intentional per the session-kind design notes:
//   1. No enableBrowserDomains. Node's V8 inspector has no Page / DOM /
//      Network domains. Calling them would surface raw CDP errors.
//   2. No Target.setAutoAttach. Node has no child sessions in v1 (Worker-
//      domain auto-attach is deferred to a later version).
//   3. Runtime.runIfWaitingForDebugger AFTER Debugger.enable. For
//      --inspect-brk targets V8 then fires the entry Debugger.paused.
//      For --inspect targets it's a no-op. We do NOT call Debugger.resume
//      from here — the entry pause flows through PauseTracker so the agent
//      can install breakpoints from a known stopped state, then resume()
//      explicitly. (Empirically verified on Node v24.13.1: without
//      runIfWaitingForDebugger V8 never fires Debugger.paused for an
//      --inspect-brk attach.)
export async function attachNode(opts: AttachNodeArgs = {}): Promise<{
  targetId: string;
  url: string;
}> {
  if (sessionState.client) throw alreadySession();
  const port = opts.port ?? DEFAULT_NODE_INSPECTOR_PORT;
  const host = opts.host ?? DEFAULT_NODE_INSPECTOR_HOST;

  return await connectNodeInspector({ host, port, attached: true });
}

export async function launchNode(opts: LaunchNodeArgs): Promise<{
  targetId: string;
  url: string;
  pid: number | null;
  port: number;
  inspectMode: "inspect" | "inspect-brk";
  cwd: string;
  script: string;
}> {
  if (sessionState.client) throw alreadySession();

  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  assertDirectory(cwd, "cwd");
  const script = isAbsolute(opts.script) ? opts.script : resolve(cwd, opts.script);
  assertFile(script, "script");

  const inspectMode = opts.inspectMode ?? "inspect-brk";
  const requestedPort = opts.inspectPort ?? 0;
  const inspectFlag = `--${inspectMode}=${DEFAULT_NODE_INSPECTOR_HOST}:${requestedPort}`;
  const args = opts.args ?? [];
  const child = spawn(process.execPath, [inspectFlag, script, ...args], {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Capture stdout/stderr into the durable pull-based buffer
  // (`sessionState.nodeOutput`). MUST be wired before waitForInspector so
  // the buffer sees startup output too: waitForInspector attaches its own
  // 'data' listeners and detaches them on success, but the chunks it
  // consumes ARE NOT replayed to listeners attached later. Without this
  // ordering, the "Debugger listening on…" banner plus any early
  // console.log / ESM-loader errors land in waitForInspector's local
  // buffer and never reach nodeOutput — exactly the diagnostics an agent
  // needs when triaging "why did my Node child fail to come up?". Both
  // listeners coexist fine on the same 'data' event (Node streams
  // multicast). (PR #81 review.)
  //
  // Side effect: attachOutputCapture's listeners drain the pipes, so the
  // prior explicit resume() that launch_node once needed is no longer required.
  attachOutputCapture(child);

  // Every launch failure path below MUST call
  // sessionState.reset() before rethrowing. reset() clears nodeOutput
  // (so a subsequent attach_node doesn't see the failed attempt's
  // startup stderr) AND bumps ownedProcessGeneration (so the
  // attachOutputCapture listeners we attached on the dying child
  // silently no-op if they fire a late 'close' / 'data' event after
  // kill). It is NOT enough to rely on connectNodeInspector's own
  // sessionState.close() catch — that catch only wraps the
  // Runtime/Debugger init block. Earlier failures in
  // connectNodeInspector (CDP.List reject, no node-type targets, CDP()
  // reject before sessionState.client is assigned) escape directly to
  // this catch with state still un-reset. (PR #81 re-review round 2 —
  // Codex P2.)
  let startup: InspectorStartup;
  try {
    startup = await waitForInspector(child, DEFAULT_LAUNCH_TIMEOUT_MS);
  } catch (e) {
    killChild(child);
    sessionState.reset();
    throw e;
  }

  try {
    const attached = await connectNodeInspector({
      host: DEFAULT_NODE_INSPECTOR_HOST,
      port: startup.port,
      attached: false,
      ownedProcess: child,
    });
    log.info("launched node", {
      pid: child.pid,
      port: startup.port,
      inspectMode,
      cwd,
      script,
    });
    return {
      ...attached,
      pid: child.pid ?? null,
      port: startup.port,
      inspectMode,
      cwd,
      script,
    };
  } catch (e) {
    killChild(child);
    // Defensive: reset() here even though connectNodeInspector's own
    // Runtime/Debugger init catch already calls sessionState.close().
    // The pre-init failures listed above (CDP.List / target filter /
    // CDP() reject) escape connectNodeInspector without ever entering
    // that inner catch, so we'd otherwise leave nodeOutput dirty for
    // exactly those failure modes. reset() is idempotent — for the
    // post-init failure path it just re-clears already-cleared state.
    sessionState.reset();
    throw e;
  }
}

async function connectNodeInspector(opts: {
  host: string;
  port: number;
  attached: boolean;
  ownedProcess?: ChildProcess;
}): Promise<{
  targetId: string;
  url: string;
}> {
  const { host, port } = opts;
  const targets = await CDP.List({ port, host });
  // Filter to Node inspector targets. The /json/list endpoint normally only
  // returns one entry with type="node" for a --inspect process, but be
  // explicit so an unexpected mixed list (e.g. a future "service-worker"
  // entry) doesn't get silently picked up by attach_node.
  // (Ultrareview round 2 — Copilot node.ts:48.)
  const nodeTargets = targets.filter((t) => t.type === "node");
  if (nodeTargets.length === 0) {
    const seen = targets.length === 0 ? "none" : targets.map((t) => t.type).join(",");
    throw new Error(
      `No Node inspector targets at ${host}:${port} (got types=[${seen}]). Is node running with --inspect or --inspect-brk?`,
    );
  }
  const target = nodeTargets[0]!;

  const client = await CDP({ port, host, target: target.id });
  sessionState.kind = "node";
  sessionState.client = client;
  sessionState.attached = opts.attached;
  sessionState.chromePort = port;
  sessionState.chromeHost = host;
  sessionState.currentTargetId = target.id;
  sessionState.ownedProcess = opts.ownedProcess
    ? { kind: "node", handle: opts.ownedProcess }
    : null;

  client.on("disconnect", () => log.warn("CDP disconnect (node)"));

  try {
    await connectDebugger(client, undefined);
    // Trigger the entry pause for --inspect-brk targets; no-op for --inspect.
    // No Debugger.resume — the entry pause flows through PauseTracker.
    await client.send("Runtime.runIfWaitingForDebugger");
  } catch (e) {
    // Partial init: Runtime/Debugger enable failed (or runIfWaiting rejected).
    // Tear the half-attached session down so the next attach attempt isn't
    // blocked by already_session against a broken state.
    // (Ultrareview round 2 — Codex Medium #1 + Copilot node.ts:63.)
    log.warn("attach_node init failed; tearing down", { error: String(e) });
    await sessionState.close();
    throw e;
  }

  log.info("attached to node", { port, host, targetId: target.id, url: target.url });
  return { targetId: target.id, url: target.url ?? "" };
}

interface InspectorStartup {
  port: number;
}

function waitForInspector(child: ChildProcess, timeoutMs: number): Promise<InspectorStartup> {
  let stdout = "";
  let stderr = "";

  return new Promise<InspectorStartup>((resolvePromise, rejectPromise) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      const detail = formatStartupOutput(stdout, stderr);
      const suffix = detail ? `\n${detail}` : "";
      const err =
        cause instanceof Error
          ? new ToolError("launch_failed", `${message}: ${cause.message}${suffix}`)
          : new ToolError("launch_failed", `${message}${suffix}`);
      rejectPromise(err);
    };

    const succeed = (port: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ port });
    };

    const inspect = () => {
      const m = LISTENING_RE.exec(stderr);
      if (!m) return;
      const port = Number(m[1]);
      if (Number.isFinite(port) && port > 0) succeed(port);
    };

    const onStdout = (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    };
    const onStderr = (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
      inspect();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      inspect();
      fail(`Node process exited before the inspector started (code=${code}, signal=${signal})`);
    };
    const onError = (err: Error) => {
      fail("Failed to launch Node process", err);
    };
    const timer = setTimeout(() => {
      fail(`Timed out after ${timeoutMs}ms waiting for Node inspector startup`);
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function assertDirectory(path: string, label: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw new ToolError("not_found", `${label} is not a directory: ${path}`);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError("not_found", `${label} not found: ${path}`);
  }
}

function assertFile(path: string, label: string): void {
  try {
    if (!statSync(path).isFile()) {
      throw new ToolError("not_found", `${label} is not a file: ${path}`);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError("not_found", `${label} not found: ${path}`);
  }
}

function appendCapped(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= OUTPUT_SNIPPET_LIMIT
    ? combined
    : combined.slice(combined.length - OUTPUT_SNIPPET_LIMIT);
}

function formatStartupOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  return parts.join("\n");
}

function killChild(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

// Per-line output cap. Matches the truncate() length in
// src/util/format.ts that get_console_logs uses, so an agent shipping
// `text` from either tool sees the same upper bound.
const NODE_OUTPUT_LINE_CAP = 1000;

// Attach `'data'` listeners to the child's stdout/stderr that split on
// newlines and push one NodeOutputEntry per line to sessionState.nodeOutput.
// Partial lines carry over across chunks. On the child's 'close' event
// (not 'exit' — see flushTrailing comment below), any trailing
// non-newline-terminated content is flushed as a final entry.
//
// Side effect: the listeners themselves drain the pipes, replacing the
// explicit resume() that launch_node used to prevent the child from blocking
// on a full stdio pipe.
//
// Why per-line rather than per-chunk: chunk boundaries are arbitrary
// (`'data'` may fire mid-line) so per-chunk entries would split log lines
// nondeterministically. Per-line is the natural unit for log analysis and
// matches what tools like `journalctl` / `kubectl logs` give an operator.
function attachOutputCapture(child: ChildProcess): void {
  const stdoutBuf = { partial: "" };
  const stderrBuf = { partial: "" };
  // Cross-session guard — snapshot the reset-generation at
  // attach time. pushLine compares against the current value; if reset()
  // has moved on (close_session ran, or a failed launch_node was
  // cleared), the listener silently no-ops rather than pushing into a
  // subsequent session's nodeOutput. See SessionState.ownedProcessGeneration.
  // (PR #81 re-review — Codex P2.)
  const myGeneration = sessionState.ownedProcessGeneration;

  // pushLine splits over-cap text into adjacent cap-sized entries —
  // preserves all bytes; continuation is implicit via adjacent `seq` on
  // the same `stream`. Symmetric for the two callers: a 2000-char single
  // line ending in '\n' splits the same way as a 2000-char no-newline
  // chunk being flushed mid-stream. (PR #81 review fix-up #2 — the
  // previous version sliced 1000 chars and discarded the remainder.)
  //
  // Empty text is preserved (a bare '\n' produces an empty entry, since
  // many log producers emit blank separator lines and dropping those
  // loses signal).
  const pushLine = (stream: "stdout" | "stderr", text: string) => {
    if (sessionState.ownedProcessGeneration !== myGeneration) return;
    if (text.length === 0) {
      sessionState.nodeOutput.push({ ts: Date.now(), stream, text: "" });
      return;
    }
    for (let offset = 0; offset < text.length; offset += NODE_OUTPUT_LINE_CAP) {
      sessionState.nodeOutput.push({
        ts: Date.now(),
        stream,
        text: text.slice(offset, offset + NODE_OUTPUT_LINE_CAP),
      });
    }
  };

  const onChunk = (stream: "stdout" | "stderr", buf: { partial: string }, chunk: Buffer) => {
    buf.partial += chunk.toString("utf8");
    while (true) {
      const newlineIdx = buf.partial.indexOf("\n");
      if (newlineIdx === -1) {
        // No newline yet. If the partial buffer exceeds the per-line cap,
        // flush the cap-aligned prefix (pushLine splits it into N
        // cap-sized entries) and keep the under-cap remainder so
        // subsequent chunks can append to it normally. This bounds
        // in-memory partial-buffer growth against a runaway producer
        // that never writes '\n'.
        if (buf.partial.length >= NODE_OUTPUT_LINE_CAP) {
          const flushLen = buf.partial.length - (buf.partial.length % NODE_OUTPUT_LINE_CAP);
          pushLine(stream, buf.partial.slice(0, flushLen));
          buf.partial = buf.partial.slice(flushLen);
        }
        return;
      }
      const line = buf.partial.slice(0, newlineIdx).replace(/\r$/, "");
      buf.partial = buf.partial.slice(newlineIdx + 1);
      pushLine(stream, line);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => onChunk("stdout", stdoutBuf, chunk));
  child.stderr?.on("data", (chunk: Buffer) => onChunk("stderr", stderrBuf, chunk));

  // Flush any trailing partial line on 'close' rather than 'exit'. The
  // child's 'exit' event fires when the process terminates, but pending
  // 'data' chunks may still be in flight on stdout/stderr — flushing too
  // early would either split the final line or miss buffered output.
  // ChildProcess 'close' is guaranteed to fire AFTER all stdio streams
  // have closed, so by then every chunk has been processed. (PR #81
  // review fix-up #4 — Copilot inline.)
  //
  // Also strips trailing '\r' to mirror the newline-splitting path —
  // otherwise a final '\r\n'-terminated chunk arriving as just '\r'
  // before the '\n' would yield a line ending in '\r'. Same Copilot note.
  const flushTrailing = (stream: "stdout" | "stderr", buf: { partial: string }) => {
    if (buf.partial.length === 0) return;
    pushLine(stream, buf.partial.replace(/\r$/, ""));
    buf.partial = "";
  };
  child.once("close", () => {
    flushTrailing("stdout", stdoutBuf);
    flushTrailing("stderr", stderrBuf);
  });
}
