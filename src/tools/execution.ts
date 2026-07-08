import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Protocol } from "devtools-protocol";
import { requireSession, requirePaused } from "../session/state.js";
import {
  mapCdpToOriginal,
  waitForConsumer,
  MAP_LOAD_WAIT_MS,
} from "../sourcemap/store.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";

export function registerExecutionTools(server: McpServer) {
  registerJsonTool(
    server,
    "resume",
    "Resume execution. Dispatched to the session that paused (root, worker, OOPIF, …).",
    undefined,
    async () => {
      const s = requirePaused();
      const sid = s.pause.current()!.sessionId;
      // Install the resumed-event listener BEFORE sending Debugger.resume.
      // CRI emits events synchronously, so the Debugger.resumed event can
      // land in the same WebSocket batch as the send response — racing the
      // send completion. (Resume/resumed race 1.)
      //
      // Promise.all (not sequential await) so the 2s waiter timeout
      // actually bounds this command even if the send hangs, and so a
      // send rejection (stale session, target detach, concurrent resume)
      // surfaces before the waiter's own timeout. cancel() in `finally`
      // is cleanup: it clears the waiter's 2s timer and removes it from
      // resumeWaiters (resolving it, not rejecting) so a send rejection
      // doesn't leave a pending waiter ticking after the tool returned.
      // (upstream review.)
      const { promise: resumed, cancel } = s.pause.waitForResumed(2000);
      try {
        // The send promise is intentionally NOT catch-guarded. If the
        // resumed-waiter times out first (Promise.all rejects) while send
        // is still pending and send rejects later, that late rejection is
        // still observed by the rejection reaction Promise.all attached to
        // the send promise — so it's harmlessly ignored, NOT an unhandled
        // rejection. We accept dropping it: a CDP send rejecting >2s after
        // the resume timeout means the session is already pathological
        // (network dead or target gone), and emitting a second error for
        // one tool call would be noise. (upstream review.)
        await Promise.all([
          s.client!.send("Debugger.resume", undefined, sid),
          resumed,
        ]);
      } finally {
        cancel();
      }
      return "resumed";
    },
  );

  registerJsonTool(
    server,
    "step_over",
    "Step over the current line. Awaits the next pause (or returns null if execution continues).",
    { timeout_ms: z.number().int().positive().optional() },
    async (input: { timeout_ms?: number }) =>
      stepThen((s, sid) => s.client!.send("Debugger.stepOver", undefined, sid), input.timeout_ms),
  );

  registerJsonTool(
    server,
    "step_into",
    "Step into the next function call.",
    { timeout_ms: z.number().int().positive().optional() },
    async (input: { timeout_ms?: number }) =>
      stepThen((s, sid) => s.client!.send("Debugger.stepInto", undefined, sid), input.timeout_ms),
  );

  registerJsonTool(
    server,
    "step_out",
    "Step out of the current function.",
    { timeout_ms: z.number().int().positive().optional() },
    async (input: { timeout_ms?: number }) =>
      stepThen((s, sid) => s.client!.send("Debugger.stepOut", undefined, sid), input.timeout_ms),
  );

  registerJsonTool(
    server,
    "pause",
    "Pause execution manually at the next statement. By default targets the root page; pass `session_id` (from list_targets or a script's session_id) to pause a specific worker/iframe/service-worker.",
    {
      session_id: z.string().nullable().optional().describe("null or omitted = root."),
    },
    async (input: { session_id?: string | null }) => {
      const s = requireSession();
      const sid = input.session_id ?? undefined;
      await s.client!.send("Debugger.pause", undefined, sid);
      return { paused_session: sid ?? null };
    },
  );

  registerJsonTool(
    server,
    "wait_for_pause",
    "Block until the debugger pauses (or times out). Returns the pause reason and a TS-mapped call stack.",
    { timeout_ms: z.number().int().positive().optional().describe("Default 30000") },
    async (input: { timeout_ms?: number }) => {
      const s = requireSession();
      const timeoutMs = input.timeout_ms ?? 30000;
      let state;
      try {
        state = await s.pause.waitForPause(timeoutMs);
      } catch (e) {
        // A bare timeout is uninformative when nothing paused — most often a
        // conditional breakpoint that could never match, or a target that ran
        // to completion. Enrich it with state read AT timeout time (none of it
        // is captured beforehand). Non-timeout rejections (e.g. "Session
        // closed") pass through unchanged.
        throw enrichPauseTimeout(s, e, timeoutMs);
      }
      return await summarizePause(s, state.reason, state.hitBreakpoints, state.data, state.callFrames, state.sessionId);
    },
  );
}

// Turn a bare wait_for_pause timeout into an actionable diagnosis. Reads live
// session state (owned-target exit + the conditional-breakpoint registry) so
// the two silent failure modes behind GitHub #46 — a never-true conditional
// bp, and a target that exited before pausing — stop looking like a generic
// timeout. Anything that isn't the timeout is returned as-is.
/** @internal exported for unit tests; not part of the MCP tool surface. */
export function enrichPauseTimeout(
  s: ReturnType<typeof requireSession>,
  err: unknown,
  timeoutMs: number,
): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!/Timed out/.test(original.message)) return original;

  const parts: string[] = [`Timed out after ${timeoutMs}ms waiting for pause.`];

  // Owned Node target exit — a synchronous, reliable read (no event wiring).
  // attach_node leaves ownedProcess null, so this only fires for launch_node.
  const owned = s.ownedProcess;
  if (owned?.kind === "node") {
    const h = owned.handle;
    if (h.exitCode != null || h.signalCode != null) {
      const how = h.signalCode ? `signal ${h.signalCode}` : `exit code ${h.exitCode}`;
      parts.push(
        `The Node target has already exited (${how}) — it ran to completion without pausing. ` +
          `A breakpoint set after its line already ran, or a conditional breakpoint whose condition was never true, will never pause.`,
      );
    }
  }

  // Conditional breakpoints that are set but didn't fire. Surface each one's
  // resolved TS location + condition so a wrong line (or an out-of-scope
  // variable) is diagnosable.
  const conditional = Array.from(s.breakpoints.values()).filter((b) => b.condition);
  if (conditional.length > 0) {
    const summary = conditional
      .map((b) => {
        const where =
          b.resolvedLocations.length > 0
            ? b.resolvedLocations.map((l) => `${l.file}:${l.line}`).join(", ")
            : `${b.file}:${b.line} (unresolved)`;
        return `  - ${b.id} bound at ${where}, condition: ${b.condition}`;
      })
      .join("\n");
    parts.push(
      `${conditional.length} conditional breakpoint(s) are set but none paused:\n${summary}\n` +
        `A conditional breakpoint fires only when its bound line is executed AND the condition is truthy there. ` +
        `If a bound line isn't the one you intended, the number may have come from compiled JS (get_script_source) rather than TS — read the TS with get_source and confirm the line, or remove the condition to check the line binds at all.`,
    );
  }

  return new ToolError("pause_timeout", parts.join("\n"));
}

async function stepThen(
  send: (s: ReturnType<typeof requirePaused>, sessionId: string | undefined) => Promise<unknown>,
  timeoutMs?: number,
) {
  const s = requirePaused();
  // Capture the paused session BEFORE marking resumed — pauseState is cleared
  // by onResumed and we still need the sessionId to route the step command.
  const sid = s.pause.current()!.sessionId;
  s.pause.onResumed();
  await send(s, sid);
  const next = await s.pause.waitForPauseOrResume(timeoutMs ?? 30000);
  if (!next) return { paused: false, message: "execution did not pause within timeout" };
  return {
    paused: true,
    ...(await summarizePause(s, next.reason, next.hitBreakpoints, next.data, next.callFrames, next.sessionId)),
  };
}

export async function summarizePause(
  s: ReturnType<typeof requireSession>,
  reason: Protocol.Debugger.PausedEvent["reason"],
  hitBreakpoints: string[] | undefined,
  data: object | undefined,
  callFrames: Protocol.Debugger.CallFrame[],
  sessionId: string | undefined,
) {
  const userBreakpointIds = matchUserBreakpoints(s, hitBreakpoints ?? [], sessionId);
  // One source-map deadline shared across every frame in this pause: a
  // 10-frame stack should burn one 500ms budget total, not 10×500ms.
  // (Source-map wait race 2.)
  const deadline = Date.now() + MAP_LOAD_WAIT_MS;
  const call_stack = await Promise.all(
    callFrames.map((cf, i) => formatFrameForPause(s, cf, i, sessionId, deadline)),
  );
  return {
    reason,
    hit_breakpoint_ids: userBreakpointIds,
    session_id: sessionId ?? null,
    data: data ?? null,
    call_stack,
  };
}

async function formatFrameForPause(
  s: ReturnType<typeof requireSession>,
  cf: Protocol.Debugger.CallFrame,
  index: number,
  sessionId: string | undefined,
  deadline: number,
) {
  // Bounded wait for this frame's source-map consumer to attach. The script
  // itself lands synchronously via Debugger.scriptParsed, but loadSourceMap
  // is fire-and-forget (sourcemap/loader.ts), so the entry pause from
  // attach_node can format frames before the consumer parses — yielding a
  // raw file:// URL in `file`. Waiting closes the gap for the realistic
  // single-script entry pause. (Source-map wait race 2.)
  //
  // Two ways the wait exits before `deadline`: this frame's predicate
  // becomes true (the typical case — consumer attached), or
  // !store.hasPendingMaps() flips because every in-flight load resolved.
  // The latter is a GLOBAL check, not per-frame: in a multi-frame pause
  // where one frame's script has no source map and another frame's map
  // is in flight, the first frame still waits on the unrelated load
  // until that load settles. Bounded by deadline, so worst-case 500ms.
  await waitForConsumer(
    s.scripts,
    () => s.scripts.get(cf.location.scriptId, sessionId)?.consumer != null,
    deadline,
  );
  const mapped = mapCdpToOriginal(s.scripts, cf.location, sessionId);
  const script = s.scripts.get(cf.location.scriptId, sessionId);
  return {
    index,
    frame_id: cf.callFrameId,
    session_id: sessionId ?? null,
    function_name: cf.functionName || "(anonymous)",
    file: mapped?.file ?? script?.url ?? cf.url ?? "<unknown>",
    line: mapped?.line ?? cf.location.lineNumber + 1,
    column: mapped?.column ?? cf.location.columnNumber ?? 0,
    js_url: script?.url,
    js_line: cf.location.lineNumber + 1,
    js_column: cf.location.columnNumber ?? 0,
    scope_types: cf.scopeChain.map((sc) => sc.type),
    this: cf.this ? { type: cf.this.subtype ?? cf.this.type, preview: cf.this.description ?? "" } : null,
  };
}

/** @internal exported for unit tests; not part of the MCP tool surface. */
export function matchUserBreakpoints(
  s: ReturnType<typeof requireSession>,
  hit: string[],
  pauseSessionId: string | undefined,
): string[] {
  if (!hit.length) return [];
  const out: string[] = [];
  for (const rec of s.breakpoints.values()) {
    // Require BOTH cdpId AND sessionId match. setBreakpointByUrl derives
    // the breakpoint ID from URL/line/column, so two sessions binding the
    // same script can mint colliding cdpIds. Without the sessionId guard,
    // a pause in one session would falsely be reported as a hit for
    // another session's binding. undefined === undefined for root.
    if (rec.bindings.some((b) => hit.includes(b.cdpId) && b.sessionId === pauseSessionId)) {
      out.push(rec.id);
    }
  }
  return out;
}
