import type CDP from "chrome-remote-interface";
import type { LaunchedChrome } from "chrome-launcher";
import type { ChildProcess } from "node:child_process";
import { PauseTracker } from "./pause.js";
import { RingBuffer, type ConsoleEntry, type NetworkEntry, type NodeOutputEntry } from "./buffers.js";
import { ScriptStore } from "../sourcemap/store.js";
import { log } from "../util/log.js";
import { noSession, notPaused, unsupportedTarget } from "../util/errors.js";
import { TOOL_KIND_SUPPORT } from "./capabilities.js";

export interface BreakpointBinding {
  cdpId: string;
  sessionId?: string;
  // The physical CDP breakpoint spec this binding requested:
  // `${sessionId ?? ""}|${url}|${line0}:${col}` (0-based line). V8 keys its
  // "Breakpoint at specified location already exists" rejection on the
  // requested url:line:col — NOT the resolved location — so this is what
  // set_breakpoint compares against to detect a real collision, instead of
  // re-mapping the (possibly since-changed) ScriptStore. See issue #24 + PR #25
  // review (false `already-set` from late-loaded code-split scripts).
  genKey?: string;
}

export interface BreakpointRecord {
  id: string; // user-facing id
  file: string;
  line: number;
  column?: number;
  condition?: string;
  logMessage?: string;
  resolvedLocations: Array<{ file: string; line: number; column: number }>;
  bindings: BreakpointBinding[];
}

export type HandlerEntry = { event: string; handler: (...args: any[]) => void };

// User-facing concept: what kind of debugging context the session represents.
// Matches the "requires a browser session" phrasing in unsupportedTarget().
// (A future non-Chromium engine would stay "browser" — the OwnedProcess.kind
// union is what grows in that case.)
export type SessionKind = "browser" | "node";

// Tags the literal process handle so close() can dispatch .kill() across
// chrome-launcher's LaunchedChrome and node:child_process's ChildProcess.
// Only present when WE launched the process — attach modes leave this null.
export type OwnedProcess =
  | { kind: "chrome"; handle: LaunchedChrome }
  | { kind: "node"; handle: ChildProcess };

const ROOT_SESSION_KEY = "__root__";
export { ROOT_SESSION_KEY };

class SessionState {
  kind: SessionKind = "browser";
  client: CDP.Client | null = null;
  ownedProcess: OwnedProcess | null = null;
  chromePort: number | null = null;
  // Host the CDP/inspector socket lives on. null means default-to-localhost
  // (chrome-launcher and node --inspect always bind 127.0.0.1; attach_chrome
  // and attach_node can target a different host). Follow-up CDP.List calls
  // (list_targets, switchTarget) read this so non-localhost attaches don't
  // silently fall back to localhost. (Ultrareview round 2 — Copilot node.ts:53.)
  chromeHost: string | null = null;
  attached = false; // true when attached to a pre-existing process (don't kill on close)

  currentTargetId: string | null = null;
  currentSessionId: string | undefined = undefined; // for flat-session targets

  readonly pause = new PauseTracker();
  readonly console = new RingBuffer<ConsoleEntry>(1000);
  readonly network = new RingBuffer<NetworkEntry>(1000);
  // Buffered stdout/stderr from lynceus-owned Node children.
  // Populated by launch_node; attach_node leaves it empty (we never see the
  // process stdio in attach mode). Exposed via the get_node_output tool.
  readonly nodeOutput = new RingBuffer<NodeOutputEntry>(1000);
  // Cross-session guard. Bumped on every `reset()`. Output-capture
  // listeners snapshot this at attach time and silently no-op if it has
  // moved on, so stale 'close' / 'data' events from a dead child can't
  // contaminate a subsequent session's `nodeOutput`. Covers two upstream
  // review races: (1) `launch_node` whose `waitForInspector` fails leaves
  // listeners attached on the dying child, and (2) `close_session`'s
  // reset can run before the child's 'close' event drains.
  ownedProcessGeneration = 0;
  readonly scripts = new ScriptStore();
  readonly breakpoints = new Map<string, BreakpointRecord>();
  // Per-session handler refs so we can removeListener on Target.detachedFromTarget.
  // Key is sessionId or ROOT_SESSION_KEY for the top-level target.
  readonly sessionHandlers = new Map<string, HandlerEntry[]>();
  // Last set_pause_on_exceptions state. Replayed to every newly-attached
  // child session in onChildAttached, so workers/iframes honor the setting
  // even when they attach after the user configured it.
  pauseOnExceptions: "none" | "uncaught" | "all" = "none";

  // Counter for generating user-friendly breakpoint IDs that survive resolve roundtrips.
  private bpCounter = 0;
  nextBpId(): string {
    this.bpCounter += 1;
    return `bp_${this.bpCounter}`;
  }

  reset() {
    this.kind = "browser";
    this.client = null;
    this.ownedProcess = null;
    this.chromePort = null;
    this.chromeHost = null;
    this.attached = false;
    this.currentTargetId = null;
    this.currentSessionId = undefined;
    this.pause.reset();
    this.console.clear();
    this.network.clear();
    this.nodeOutput.clear();
    this.scripts.clear();
    this.breakpoints.clear();
    this.sessionHandlers.clear();
    this.pauseOnExceptions = "none";
    this.bpCounter = 0;
    // Bump LAST so any listener that snapshots `ownedProcessGeneration`
    // before reset() sees the new value once they next push, regardless
    // of whether they were mid-flight when reset ran.
    this.ownedProcessGeneration += 1;
  }

  async close(): Promise<void> {
    log.info("closing session");
    try {
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        if (this.ownedProcess && !this.attached) {
          const owned = this.ownedProcess;
          if (owned.kind === "node") {
            // SIGTERM-first, escalate to SIGKILL after a grace
            // window so a Node script with a SIGTERM handler (or one
            // paused at a breakpoint) can't outlive close_session.
            try {
              await killNodeChild(owned.handle, NODE_KILL_GRACE_MS);
            } catch {
              /* ignore — process may have raced to exit during the wait */
            }
          } else {
            // chrome-launcher manages its own kill-then-wait sequence
            // (see LaunchedChrome.kill()); don't duplicate it here.
            try {
              owned.handle.kill();
            } catch {
              /* ignore */
            }
          }
        }
      } finally {
        this.reset();
      }
    }
  }
}

// Grace window before escalating SIGTERM → SIGKILL on an owned
// Node child. 2000ms balances "let well-behaved Node code flush stdout +
// run process.on('exit') handlers" against "don't make close_session feel
// sluggish for runaway processes". Exported so L2 tests can pass a short
// override and so the value is discoverable in one place.
export const NODE_KILL_GRACE_MS = 2000;

// Send SIGTERM to an owned Node child, wait up to `graceMs` for it to
// exit, then escalate to SIGKILL if it's still running. Idempotent for
// already-exited children; swallows ESRCH-style races where the child
// died between checks.
//
// Windows note: Node maps both SIGTERM and SIGKILL to TerminateProcess,
// so the escalation is a harmless no-op there — the first kill() ends
// the process regardless of which signal name we pass. No platform
// branching needed in the helper.
//
// Why a LOCAL `exited` flag instead of relying solely on `child.exitCode`
// / `child.signalCode`: the L2 fake-CDP test children emit 'exit' but
// don't necessarily mutate those properties. Tracking exit via the event
// listener directly keeps the helper honest against both real Node
// `ChildProcess` and the mock used in `test/tools/session.test.ts`.
//
// We use `!= null` (loose) rather than `!== null` (strict) for the
// already-exited check because the L2 fake `ChildProcess` doesn't
// initialize `exitCode` / `signalCode` to null — they're `undefined`
// until the test sets them. Strict `!== null` would treat `undefined` as
// "already exited" and skip the kill on every mocked Node session. Real
// Node `ChildProcess` always sets them to null while alive, so loose
// equality is correct for both shapes.
export async function killNodeChild(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return; // already exited — nothing to send
  }
  let exited = false;
  let resolveExited: () => void = () => {};
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const onExit = () => {
    exited = true;
    resolveExited();
  };
  child.once("exit", onExit);
  let sigtermSent = false;
  try {
    sigtermSent = child.kill("SIGTERM");
  } catch {
    /* fall through with sigtermSent = false (e.g. ESRCH) */
  }
  if (!sigtermSent) {
    // Signal couldn't be delivered — treat as already gone. Remove the
    // exit listener registered above so it doesn't linger on the
    // ChildProcess for the rest of its lifetime.
    child.removeListener("exit", onExit);
    return;
  }
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, graceMs);
    }),
  ]);
  if (graceTimer) clearTimeout(graceTimer);
  if (exited || child.exitCode != null || child.signalCode != null) {
    return; // SIGTERM was enough
  }
  log.info(
    `escalating SIGTERM → SIGKILL on owned Node child (PID ${child.pid ?? "?"}; ${graceMs}ms grace expired)`,
  );
  try {
    child.kill("SIGKILL");
  } catch {
    /* race window between graceExpired and the SIGKILL call; harmless */
  }
  // Best-effort short wait so close_session typically returns AFTER the
  // process is reaped, not while SIGKILL is still in flight. Capped at
  // 500ms — more than the kernel needs to deliver the signal and emit
  // 'exit' under normal conditions. NOT a guarantee: if SIGKILL isn't
  // honored (kernel pathology), the timer fires and we return anyway
  // so close_session can't hang indefinitely.
  let postKillTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => {
      postKillTimer = setTimeout(resolve, 500);
    }),
  ]);
  if (postKillTimer) clearTimeout(postKillTimer);
}

export const sessionState = new SessionState();

export function getSession(): SessionState | null {
  return sessionState.client ? sessionState : null;
}

export function requireSession(): SessionState {
  if (!sessionState.client) throw noSession();
  return sessionState;
}

export function requirePaused(): SessionState {
  const s = requireSession();
  if (!s.pause.isPaused()) throw notPaused();
  return s;
}

// Throws unsupported_target if the active session's kind isn't in the tool's
// capability set. Permissive when the tool isn't listed — the table began with
// only the select_target entry (self-protection during the state refactor) and
// the rest of the tools were added as the session-kind split landed.
export function requireCapable(s: SessionState, tool: string): void {
  const allowed = TOOL_KIND_SUPPORT[tool];
  if (!allowed) return;
  if (!allowed.has(s.kind)) throw unsupportedTarget(tool, s.kind, allowed);
}

// Single entry-point for "attach event listener AND track for teardown".
// Doing both here is deliberate: a tracking-only helper would let a caller
// forget the matching client.on (silently drop events), and an attach-only
// helper would leak the listener on detach. Used by connectDebugger
// and the browser-specific enableBrowserDomains.
export function registerHandler(
  s: SessionState,
  client: CDP.Client,
  sessionId: string | undefined,
  event: string,
  handler: (...args: any[]) => void,
): void {
  (client as unknown as { on: (e: string, h: (...args: any[]) => void) => void }).on(event, handler);
  const key = sessionId ?? ROOT_SESSION_KEY;
  const list = s.sessionHandlers.get(key) ?? [];
  list.push({ event, handler });
  s.sessionHandlers.set(key, list);
}

export type Session = SessionState;
