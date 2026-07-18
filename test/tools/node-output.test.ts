// L2 contract tests for get_node_output and the launch_node →
// nodeOutput pipeline. Two layers:
//
//   1. Tool-surface query semantics (mirrors test/tools/console.test.ts):
//      pagination via `since`, `stream` filter, `search` filter, truncation,
//      empty-list cursor round-trip, no_session, capability gating.
//
//   2. Capture-path wiring: a real launch_node call with a mocked
//      child_process.spawn whose stdout/stderr we drive directly. Pins the
//      line-splitter behavior — multi-line chunks split into N entries,
//      partial lines carry across chunks, trailing \r is stripped, exit
//      flushes any unterminated trailing content, and very-long lines
//      truncate at the per-line cap rather than letting the partial buffer
//      grow unboundedly.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { getSession, requireSession } from "../../src/session/state.js";
import { makeFakeCdp, type FakeCdp } from "../fake-cdp.js";

// Same mock seam as test/tools/session.test.ts — chrome-remote-interface +
// child_process.spawn need vi.mock interception because they're imported
// statically by src/session/node.ts. The session-test file documents the
// asymmetry; see test/tools/session.test.ts lines 8–16.
const cdpListMock = vi.fn<(opts: any) => Promise<any[]>>();
let nextFakeForConnect: FakeCdp | null = null;
vi.mock("chrome-remote-interface", () => {
  const def: any = (_opts: any) => Promise.resolve(nextFakeForConnect);
  def.List = (opts: any) => cdpListMock(opts);
  return { default: def };
});

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: any[]) => spawnMock(...args) };
});

import { registerNodeOutputTools } from "../../src/tools/node-output.js";
import { registerSessionTools } from "../../src/tools/session.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const nodeOutputTools = captureTools(registerNodeOutputTools);
const getOutput = nodeOutputTools.get("get_node_output")!;

const sessionTools = captureTools(registerSessionTools);
const launchNode = sessionTools.get("launch_node")!;

beforeEach(() => {
  cdpListMock.mockReset();
  spawnMock.mockReset();
  nextFakeForConnect = makeFakeCdp();
});

const seedOutput = (stream: "stdout" | "stderr", text: string) => {
  requireSession().nodeOutput.push({
    ts: Date.now(),
    stream,
    text,
  });
};

describe("get_node_output — query semantics (buffer pre-seeded)", () => {
  it("no_session: structured error envelope when no session is active", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getOutput.handler({}))?.error).toBe("no_session");
  });

  it("unsupported_target: rejects on a browser session because there is no Chrome stdio surface", async () => {
    setupSession({ kind: "browser" });
    const err = parseErrorEnvelope(await getOutput.handler({}));
    expect(err?.error).toBe("unsupported_target");
    expect(err?.message).toBe(
      "Tool get_node_output requires a node session (current session is browser)",
    );
  });

  it("returns buffered entries with cursor equal to the last item's seq", async () => {
    setupSession({ kind: "node" });
    seedOutput("stdout", "one");
    seedOutput("stderr", "two");
    seedOutput("stdout", "three");
    const r = parseOkEnvelope<{ cursor: number; items: any[] }>(await getOutput.handler({}));
    expect(r.items.map((i) => i.text)).toEqual(["one", "two", "three"]);
    expect(r.items.map((i) => i.stream)).toEqual(["stdout", "stderr", "stdout"]);
    // Cursor matches the last seq; tested relationally because RingBuffer.nextSeq
    // persists across resets — same pattern as console.test.ts.
    expect(r.cursor).toBe(r.items[r.items.length - 1].seq);
  });

  it("`since` paginates from a previous cursor", async () => {
    setupSession({ kind: "node" });
    for (let i = 0; i < 5; i++) seedOutput("stdout", `m${i}`);
    const first = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getOutput.handler({ limit: 2 }),
    );
    expect(first.items.map((i) => i.text)).toEqual(["m3", "m4"]);
    seedOutput("stdout", "m5");
    const next = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getOutput.handler({ since: first.cursor }),
    );
    expect(next.items.map((i) => i.text)).toEqual(["m5"]);
  });

  it("`stream` filter narrows to one pipe", async () => {
    setupSession({ kind: "node" });
    seedOutput("stdout", "out-1");
    seedOutput("stderr", "err-1");
    seedOutput("stdout", "out-2");
    const stdoutOnly = parseOkEnvelope<{ items: any[] }>(
      await getOutput.handler({ stream: "stdout" }),
    );
    expect(stdoutOnly.items.map((i) => i.text)).toEqual(["out-1", "out-2"]);
    const stderrOnly = parseOkEnvelope<{ items: any[] }>(
      await getOutput.handler({ stream: "stderr" }),
    );
    expect(stderrOnly.items.map((i) => i.text)).toEqual(["err-1"]);
  });

  it("`search` filter is case-insensitive substring match", async () => {
    setupSession({ kind: "node" });
    seedOutput("stdout", "Listening on :3000");
    seedOutput("stdout", "Database OK");
    const r = parseOkEnvelope<{ items: any[] }>(
      await getOutput.handler({ search: "DATABASE" }),
    );
    expect(r.items.map((i) => i.text)).toEqual(["Database OK"]);
  });

  it("truncates per-line text to 1000 chars on the projection", async () => {
    setupSession({ kind: "node" });
    const big = "x".repeat(2500);
    seedOutput("stdout", big);
    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items[0].text.length).toBeLessThan(big.length);
    expect(r.items[0].text).toContain("…(+");
  });

  it("returns input cursor (not 0) when no items match — keeps polling stable", async () => {
    setupSession({ kind: "node" });
    seedOutput("stdout", "old");
    const r = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getOutput.handler({ since: 99 }),
    );
    expect(r.items).toEqual([]);
    expect(r.cursor).toBe(99);
  });
});

describe("get_node_output — registration metadata", () => {
  it("registers exactly one tool", () => {
    expect(Array.from(nodeOutputTools.keys())).toEqual(["get_node_output"]);
  });
});

describe("launch_node → nodeOutput capture pipeline", () => {
  const fixtureScript = "test/fixtures/node-launch-entry.js";

  // Mocked Node child with controllable stdio. Mirrors makeFakeNodeChild in
  // test/tools/session.test.ts: kill() emits 'exit' and records the signal
  // like a real ChildProcess, so the launch-failure paths that close an
  // owned child (the round-2 early ownedProcess assignment makes the child
  // visible to close() from spawn time) resolve killNodeChild's escalation
  // promptly instead of sitting out the SIGTERM→SIGKILL grace window.
  function makeFakeNodeChild(pid = 7777) {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.signalCode = null;
    child.kill = vi.fn(() => {
      if (child.signalCode == null) {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      }
      return true;
    });
    return child;
  }

  function arrangeLaunchedNode(port = 4567) {
    const child = makeFakeNodeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.write(`Debugger listening on ws://127.0.0.1:${port}/abc\n`);
      });
      return child;
    });
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    return child;
  }

  it("captures startup stderr (upstream fix-up #1: capture is installed BEFORE waitForInspector)", async () => {
    // Regression for the original landing of get_node_output, which installed
    // attachOutputCapture AFTER waitForInspector. waitForInspector
    // attaches its own 'data' listeners that consume the startup
    // "Debugger listening on ws://…" line, then detach on success. With
    // the listener installed after, the post-startup capture saw an
    // already-empty stream and the banner (plus any early stdout/stderr)
    // was silently lost — exactly the data an agent needs to triage a
    // launch failure.
    const child = arrangeLaunchedNode(4567);
    await launchNode.handler({ script: fixtureScript });
    // Let the queued stderr emission fire if it hasn't already.
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    const startupLines = r.items.filter((i) => i.stream === "stderr");
    expect(startupLines.length).toBeGreaterThanOrEqual(1);
    expect(startupLines[0].text).toMatch(/Debugger listening on ws:\/\/127\.0\.0\.1:4567\//);
  });

  it("captures one entry per newline; entries carry the right stream label", async () => {
    const child = arrangeLaunchedNode();
    await launchNode.handler({ script: fixtureScript });
    // Clear the startup-banner entry pushed by the test above's regression
    // (capture is wired BEFORE waitForInspector now, so the banner lands in
    // the buffer too). Assertions below pin only what we drive here.
    requireSession().nodeOutput.clear();

    child.stdout.write("hello\nworld\n");
    child.stderr.write("warn: x\n");
    // Allow the stream's 'data' events to fire.
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items.map((i) => `${i.stream}:${i.text}`)).toEqual([
      "stdout:hello",
      "stdout:world",
      "stderr:warn: x",
    ]);
  });

  it("partial lines carry across chunks; \\r\\n is normalized by stripping trailing \\r", async () => {
    const child = arrangeLaunchedNode();
    await launchNode.handler({ script: fixtureScript });
    requireSession().nodeOutput.clear();

    // Split a line across two chunks; second chunk uses \r\n.
    child.stdout.write("part-");
    child.stdout.write("one\r\n");
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    // One assembled line, with \r stripped — NOT "part-one\r".
    expect(r.items.map((i) => i.text)).toEqual(["part-one"]);
  });

  it("on process 'close', trailing unterminated content is flushed (upstream fix-up #4: 'close' not 'exit')", async () => {
    // Regression for the original landing of get_node_output, which flushed on
    // 'exit'. 'exit' fires when the process terminates but pending
    // 'data' chunks may still be queued on stdout/stderr; the
    // ChildProcess 'close' event is the safe hook because it fires
    // AFTER all stdio streams have closed.
    const child = arrangeLaunchedNode();
    await launchNode.handler({ script: fixtureScript });
    requireSession().nodeOutput.clear();

    child.stdout.write("final-without-newline");
    child.emit("close", 0, null);
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items.map((i) => i.text)).toEqual(["final-without-newline"]);
  });

  it("on 'close', trailing partial line strips a final '\\r' the same way the newline path does (upstream Copilot review)", async () => {
    // An unterminated CRLF fragment arriving as '...\r' (with '\n' lost
    // or never sent) would otherwise yield a line ending in '\r'.
    const child = arrangeLaunchedNode();
    await launchNode.handler({ script: fixtureScript });
    requireSession().nodeOutput.clear();

    child.stdout.write("partial-cr\r");
    child.emit("close", 0, null);
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items.map((i) => i.text)).toEqual(["partial-cr"]);
  });

  it("over-cap line with no newline preserves all bytes across adjacent cap-sized entries (upstream fix-up #2)", async () => {
    // Regression for the original landing: a 2500-char no-newline write
    // sliced the first 1000 chars and discarded the rest. Fix: loop,
    // emitting one cap-sized entry per window — preserves all bytes;
    // continuation is implicit via adjacent `seq` on the same `stream`.
    const child = arrangeLaunchedNode();
    await launchNode.handler({ script: fixtureScript });
    requireSession().nodeOutput.clear();

    const blob = "y".repeat(2500);
    child.stdout.write(blob);
    await new Promise<void>((r) => setImmediate(r));
    // Flush the trailing under-cap remainder via 'close' so all 2500
    // bytes have landed when we read.
    child.emit("close", 0, null);
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    // Three entries: 1000 + 1000 + 500. All same stream. Concatenated
    // text equals the original blob exactly (NO data loss).
    expect(r.items.length).toBeGreaterThanOrEqual(3);
    const stdoutItems = r.items.filter((i) => i.stream === "stdout");
    const concatenated = stdoutItems.map((i) => i.text).join("");
    expect(concatenated).toBe(blob);
    // Each entry respects the cap (capture-time invariant).
    for (const item of stdoutItems) {
      expect(item.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it("attach_node leaves nodeOutput empty (we don't own the child's stdio)", async () => {
    // No spawn — we're testing the attach-mode contract, not launch.
    const attachNode = sessionTools.get("attach_node")!;
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await attachNode.handler({});

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items).toEqual([]);
  });

  it("post-inspector launch failure also clears nodeOutput (upstream re-review round 2 — Codex P2)", async () => {
    // Codex re-review caught that my first fix-up only handled the
    // waitForInspector failure path. connectNodeInspector has THREE
    // failure modes that throw BEFORE its inner Runtime/Debugger init
    // catch runs: CDP.List rejecting, the type === "node" filter
    // yielding zero targets, and CDP() rejecting before
    // s.client is assigned. None of those reach
    // connectNodeInspector's own s.close() — they escape
    // straight to launchNode's outer catch, which previously did NOT
    // reset state. Without the outer-catch reset, the inspector
    // banner captured during the successful waitForInspector phase
    // would leak into the next session's nodeOutput.
    const child = makeFakeNodeChild(9999);
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        // Banner DOES emit — waitForInspector will succeed.
        child.stderr.write("Debugger listening on ws://127.0.0.1:4567/abc\n");
      });
      return child;
    });
    // …but CDP.List returns no node-type targets, so the filter at
    // src/session/node.ts:143 throws.
    cdpListMock.mockResolvedValue([]);

    const r = await launchNode.handler({ script: fixtureScript });
    expect(parseErrorEnvelope(r)?.error).toBeDefined();
    // The failed launch aborted its reservation, taking the banner-carrying
    // instance (and its dirty nodeOutput) with it — no session survives to
    // leak into the attach below.
    expect(getSession()).toBeNull();

    const attachNode = sessionTools.get("attach_node")!;
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await attachNode.handler({});
    const out = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(out.items).toEqual([]);
  });

  it("failed launch_node followed by attach_node leaves nodeOutput empty (upstream re-review — Codex P2 race 1)", async () => {
    // Regression for cross-session contamination on failed launch. The
    // failed attempt's stderr (e.g., an ESM-loader error or any startup
    // noise) would otherwise sit in the session's nodeOutput and be
    // exposed by the next attach_node, breaking the documented
    // "attach_node leaves nodeOutput empty" contract.
    const failingChild = makeFakeNodeChild(8888);
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        failingChild.stderr.write("noise before the inspector fails to come up\n");
        // No "Debugger listening" line — emit exit so waitForInspector
        // fails fast with launch_failed instead of timing out.
        failingChild.emit("exit", 1, null);
      });
      return failingChild;
    });
    const failedR = await launchNode.handler({ script: fixtureScript });
    expect(parseErrorEnvelope(failedR)?.error).toBe("launch_failed");
    // Sanity: the failed-launch path aborted its reservation, so no session
    // (and no dirty buffer) survives the failure to be seen by the attach.
    expect(getSession()).toBeNull();

    const attachNode = sessionTools.get("attach_node")!;
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await attachNode.handler({});

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items).toEqual([]);
  });

  it("late 'close' on a previous child does not contaminate a subsequent session (upstream re-review — Codex P2 race 2)", async () => {
    // Regression for the close-vs-reset race. close_session resets the
    // session instance, but the previous child's 'close' event can
    // fire later — the SIGTERM/SIGKILL escalation only waits
    // for 'exit', not 'close'. Registry-world note (round-1 review): the
    // stale listener closes over the OLD instance, so cross-session
    // contamination is structurally impossible now and the
    // ownedProcessGeneration guard is defense-in-depth (it stops the dead
    // instance's buffer from mutating post-reset). This test pins the
    // observable contract either way: the new session's buffer stays clean.
    const child1 = arrangeLaunchedNode(4567);
    await launchNode.handler({ script: fixtureScript });
    // Sanity: write a trailing-partial line so the 'close' flush has
    // work to do.
    child1.stdout.write("trailing-from-old-child");
    await new Promise<void>((r) => setImmediate(r));

    // Simulate close_session by resetting the live instance directly. This
    // bumps ownedProcessGeneration, the snapshot guard's invariant.
    const s = requireSession();
    s.reset();
    expect(s.nodeOutput.size()).toBe(0);

    // Spin up a fresh Node session. setupSession drops the old record and
    // mints a fresh instance; child1's listener still closes over the OLD
    // instance, whose bumped generation invalidates it.
    setupSession({ kind: "node" });

    // NOW the old child's 'close' fires. Without the guard, this would
    // push "trailing-from-old-child" into the new session's buffer.
    child1.emit("close", null, null);
    await new Promise<void>((r) => setImmediate(r));

    const r = parseOkEnvelope<{ items: any[] }>(await getOutput.handler({}));
    expect(r.items.map((i) => i.text)).not.toContain("trailing-from-old-child");
    // Stronger pin: buffer should still be empty (no entries from any
    // stale listener at all).
    expect(r.items).toEqual([]);
  });
});
