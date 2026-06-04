import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Protocol } from "devtools-protocol";
import { requireSession, requirePaused } from "../session/state.js";
import { mapCdpToOriginal } from "../sourcemap/store.js";
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
      await s.client!.send("Debugger.resume", undefined, sid);
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
      const state = await s.pause.waitForPause(input.timeout_ms ?? 30000);
      return summarizePause(s, state.reason, state.hitBreakpoints, state.data, state.callFrames, state.sessionId);
    },
  );
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
    ...summarizePause(s, next.reason, next.hitBreakpoints, next.data, next.callFrames, next.sessionId),
  };
}

export function summarizePause(
  s: ReturnType<typeof requireSession>,
  reason: Protocol.Debugger.PausedEvent["reason"],
  hitBreakpoints: string[] | undefined,
  data: object | undefined,
  callFrames: Protocol.Debugger.CallFrame[],
  sessionId: string | undefined,
) {
  const userBreakpointIds = matchUserBreakpoints(s, hitBreakpoints ?? [], sessionId);
  return {
    reason,
    hit_breakpoint_ids: userBreakpointIds,
    session_id: sessionId ?? null,
    data: data ?? null,
    call_stack: callFrames.map((cf, i) => formatFrameForPause(s, cf, i, sessionId)),
  };
}

function formatFrameForPause(
  s: ReturnType<typeof requireSession>,
  cf: Protocol.Debugger.CallFrame,
  index: number,
  sessionId: string | undefined,
) {
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
