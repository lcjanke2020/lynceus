import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession, ROOT_SESSION_KEY, type BreakpointRecord, type BreakpointBinding } from "../session/state.js";
import { mapOriginalToGenerated, mapCdpToOriginal, type GeneratedLocation } from "../sourcemap/store.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";

// Look up an existing breakpoint by normalized (file, line, column). Column
// is always a number here — the caller is responsible for collapsing an
// omitted or undefined `input.column` to 0 before calling, matching the
// `input.column ?? 0` shape that mapOriginalToGenerated and list_breakpoints
// already use. If the three normalizations ever diverge, set_breakpoint's
// idempotent path silently breaks (see PR #20 review).
function findBreakpointAt(
  breakpoints: Map<string, BreakpointRecord>,
  file: string,
  line: number,
  column: number,
): BreakpointRecord | undefined {
  for (const r of breakpoints.values()) {
    if (r.file === file && r.line === line && (r.column ?? 0) === column) return r;
  }
  return undefined;
}

// Physical CDP breakpoint identity for a generated location. A breakpoint is
// bound by (sessionId, url, line, col), so two candidates with the same key are
// the same CDP breakpoint. Mirrors the dedup key in mapOriginalToGenerated.
function genKey(g: GeneratedLocation): string {
  return `${g.sessionId ?? ""}|${g.scriptUrl}|${g.lineNumber}:${g.columnNumber}`;
}

function breakpointEnvelope(r: BreakpointRecord, status: "set" | "already-set") {
  return {
    id: r.id,
    resolved_locations: r.resolvedLocations,
    binding_count: r.bindings.length,
    sessions_bound: Array.from(new Set(r.bindings.map((b) => b.sessionId ?? ROOT_SESSION_KEY))),
    status,
  };
}

export function registerBreakpointTools(server: McpServer) {
  registerJsonTool(
    server,
    "set_breakpoint",
    'Set a breakpoint in TypeScript source. Resolves matching scripts via source maps (including in workers and iframes) and binds in each one\'s session. Returns the resolved JS->TS locations. Idempotent: re-calling with identical (file, line, column, condition, log_message) returns the existing breakpoint id with status: "already-set". Same location with a different condition/log_message returns error: "breakpoint_conflict" — remove the existing breakpoint first.',
    {
      file: z.string().describe("TS file path or fragment (e.g. src/foo.ts)"),
      line: z.number().int().positive().describe("1-based"),
      column: z.number().int().nonnegative().optional(),
      condition: z.string().optional().describe("Expression — pause only when truthy"),
      log_message: z.string().optional().describe("Logpoint: log instead of pausing"),
    },
    async (input: { file: string; line: number; column?: number; condition?: string; log_message?: string }) => {
      const s = requireSession();
      // Normalize once at the top so lookup, mapping, and storage cannot
      // drift. column collapses `undefined` and omitted to 0 — matching what
      // mapOriginalToGenerated and list_breakpoints already do. condition /
      // logMessage truthy-normalize so the empty string and undefined match.
      const file = input.file;
      const line = input.line;
      const column = input.column ?? 0;
      const condition = input.condition || undefined;
      const logMessage = input.log_message || undefined;
      const existing = findBreakpointAt(s.breakpoints, file, line, column);
      if (existing) {
        if (existing.condition === condition && existing.logMessage === logMessage) {
          return breakpointEnvelope(existing, "already-set");
        }
        const locStr = `${file}:${line}:${column}`;
        throw new ToolError(
          "breakpoint_conflict",
          `Breakpoint already exists at ${locStr} (id ${existing.id}) with a different condition or log_message. Remove it first (remove_breakpoint) before setting a new one.`,
        );
      }
      const candidates = mapOriginalToGenerated(s.scripts, file, line, column);
      if (candidates.length === 0) {
        throw new ToolError(
          "no_mapping",
          `No source-mapped script matches '${file}:${line}'. Try list_scripts to confirm what's loaded.`,
        );
      }
      // Generated-layer idempotency. findBreakpointAt() above matches on the
      // *TS* coordinate, but two different TS lines can minify to the SAME
      // generated position — and since we bind by `url`, CDP rejects the
      // second with "Breakpoint at specified location already exists" (a
      // non-recoverable internal_error, issue #24). If an already-set
      // breakpoint covers these generated locations, treat this as the same
      // breakpoint instead of issuing a colliding setBreakpointByUrl.
      const candKeys = new Set(candidates.map(genKey));
      for (const r of s.breakpoints.values()) {
        const overlaps = mapOriginalToGenerated(s.scripts, r.file, r.line, r.column ?? 0).some((g) =>
          candKeys.has(genKey(g)),
        );
        if (!overlaps) continue;
        if (r.condition === condition && r.logMessage === logMessage) {
          return breakpointEnvelope(r, "already-set");
        }
        const locStr = `${file}:${line}:${column}`;
        throw new ToolError(
          "breakpoint_conflict",
          `Breakpoint ${r.id} (${r.file}:${r.line}) already binds the same compiled location as ${locStr} with a different condition or log_message. Remove it first (remove_breakpoint) before setting a new one.`,
        );
      }
      const id = s.nextBpId();
      const bindings: BreakpointBinding[] = [];
      const resolved: BreakpointRecord["resolvedLocations"] = [];
      const conditionExpr = buildConditionExpression(condition, logMessage);
      for (const c of candidates) {
        // Use the exact `url` field rather than `urlRegex`. CDP's regex is
        // unanchored — `http://localhost/main.js` as a urlRegex also matches
        // `http://localhost/main.js?v=2`, `…?vue&type=template`, etc.
        const params = {
          url: c.scriptUrl,
          lineNumber: c.lineNumber,
          columnNumber: c.columnNumber,
          ...(conditionExpr ? { condition: conditionExpr } : {}),
        };
        const res = await s.client!.send("Debugger.setBreakpointByUrl", params, c.sessionId);
        bindings.push({ cdpId: res.breakpointId, ...(c.sessionId ? { sessionId: c.sessionId } : {}) });
        for (const loc of res.locations) {
          const orig = mapCdpToOriginal(s.scripts, loc, c.sessionId);
          if (orig) resolved.push(orig);
          else resolved.push({ file: c.scriptUrl, line: loc.lineNumber + 1, column: loc.columnNumber ?? 0 });
        }
      }
      const record: BreakpointRecord = {
        id,
        file,
        line,
        column,
        ...(condition ? { condition } : {}),
        ...(logMessage ? { logMessage } : {}),
        resolvedLocations: resolved,
        bindings,
      };
      s.breakpoints.set(id, record);
      return breakpointEnvelope(record, "set");
    },
  );

  registerJsonTool(
    server,
    "remove_breakpoint",
    "Remove a breakpoint by ID (returned from set_breakpoint).",
    { id: z.string() },
    async (input: { id: string }) => {
      const s = requireSession();
      const rec = s.breakpoints.get(input.id);
      if (!rec) throw new ToolError("not_found", `No breakpoint with id ${input.id}`);
      for (const b of rec.bindings) {
        try {
          await s.client!.send("Debugger.removeBreakpoint", { breakpointId: b.cdpId }, b.sessionId);
        } catch {
          /* ignore — session may already be gone */
        }
      }
      s.breakpoints.delete(input.id);
      return "removed";
    },
  );

  registerJsonTool(
    server,
    "list_breakpoints",
    "List all currently active breakpoints.",
    undefined,
    async () => {
      const s = requireSession();
      return Array.from(s.breakpoints.values()).map((bp) => ({
        id: bp.id,
        file: bp.file,
        line: bp.line,
        column: bp.column ?? 0,
        condition: bp.condition,
        log_message: bp.logMessage,
        resolved_locations: bp.resolvedLocations,
        binding_count: bp.bindings.length,
      }));
    },
  );

  registerJsonTool(
    server,
    "set_pause_on_exceptions",
    "Configure whether the debugger pauses on exceptions. Applies to the root AND all currently-attached child sessions (workers/iframes/service workers), and is remembered so newly-attached children inherit the setting.",
    {
      state: z.enum(["none", "uncaught", "all"]),
    },
    async (input: { state: "none" | "uncaught" | "all" }) => {
      const s = requireSession();
      // Persist so onChildAttached can replay to future attachments.
      s.pauseOnExceptions = input.state;
      // Apply to every currently-attached session. ROOT_SESSION_KEY → undefined
      // for the CDP call; child keys are the literal sessionId.
      const targetSessions: Array<string | undefined> = [];
      for (const key of s.sessionHandlers.keys()) {
        targetSessions.push(key === ROOT_SESSION_KEY ? undefined : key);
      }
      if (targetSessions.length === 0) targetSessions.push(undefined); // safety net
      const results = await Promise.allSettled(
        targetSessions.map((sid) =>
          s.client!.send("Debugger.setPauseOnExceptions", { state: input.state }, sid),
        ),
      );
      const failures = results
        .map((r, i) => (r.status === "rejected" ? { sid: targetSessions[i] ?? "__root__", error: String(r.reason) } : null))
        .filter((x): x is { sid: string; error: string } => x !== null);
      return {
        state: input.state,
        sessions_applied: targetSessions.length - failures.length,
        failures,
      };
    },
  );
}

// Combine an optional `condition` predicate with an optional `logMessage`.
// Logpoint: emit a console.log and never pause (`false` short-circuits).
/** @internal exported for unit tests; not part of the MCP tool surface. */
export function buildConditionExpression(condition?: string, logMessage?: string): string | undefined {
  if (!condition && !logMessage) return undefined;
  if (logMessage) {
    const tmpl = JSON.stringify(logMessage);
    const log = `console.log(${tmpl}.replace(/\\{([^}]+)\\}/g, (m, expr) => { try { return String(eval(expr)); } catch (e) { return "{" + expr + "=?}"; } }))`;
    if (condition) return `(${condition}) && (${log}, false)`;
    return `(${log}, false)`;
  }
  return condition;
}
