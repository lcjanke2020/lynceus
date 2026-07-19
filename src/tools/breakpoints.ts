import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession, ROOT_SESSION_KEY, type BreakpointRecord, type BreakpointBinding } from "../session/state.js";
import {
  isLineMapped,
  mapOriginalToGenerated,
  mapCdpToOriginal,
  nearestMappedLines,
  type GeneratedLocation,
  type ScriptStore,
} from "../sourcemap/store.js";
import { normalizeSourcePath, pathMatches } from "../sourcemap/normalize.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";
import { sessionSchema, type SessionInput } from "./_session_input.js";

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

// Cap on how many mapped paths a no_mapping error echoes inline; the full
// per-script view stays behind list_scripts (itself capped at 30 per script).
const MAX_ECHOED_SOURCES = 20;
const MAX_DID_YOU_MEAN = 5;

const lastSegment = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// Build the no_mapping error (GH #37, hardened in PR #59 round 1).
// mapOriginalToGenerated returning no candidates conflates situations an
// agent recovers from differently, so say which one it is instead of always
// pointing at list_scripts:
//   - `file` and `line` ARE mapped (column-broad) → the miss is either an
//     explicit `column` with no mapping at/after it, or a map that finished
//     attaching after the lookup gave up (await-boundary race) — both are
//     "retry with a cheaper coordinate", never "line has no code";
//   - `file` IS mapped, `line` has no generated position (blank line,
//     comment, type-only code) → suggest the nearest mapped line(s);
//   - maps are loaded but none references `file` → echo the matchable paths,
//     same-basename ones first, so one corrected call fixes it;
//   - nothing is mapped at all → likely a load race or nothing parsed yet.
// When other maps are still in flight, the loaded-map picture may be
// incomplete — say so rather than presenting it as definitive.
// Exported for direct unit tests: the attach-race arm is unreachable
// deterministically through the tool handler (it needs a map to land between
// the lookup and this classifier).
export function noMappingError(
  scripts: ScriptStore,
  file: string,
  line: number,
  column: number,
): ToolError {
  const pendingNote = scripts.hasPendingMaps()
    ? " Note: some source maps are still loading, so this picture may be incomplete — retrying shortly may also resolve it."
    : "";
  if (scripts.findByOriginalSource(file).length > 0) {
    if (isLineMapped(scripts, file, line)) {
      if (column > 0) {
        return new ToolError(
          "no_mapping",
          `'${file}' line ${line} is source-mapped, but nothing maps at or after column ${column}. ` +
            `Retry without column — set_breakpoint binds at the line's first mapped column by default.`,
        );
      }
      return new ToolError(
        "no_mapping",
        `'${file}:${line}' is mapped now but was not when the lookup ran — its source map likely finished loading mid-call. Retry set_breakpoint.`,
      );
    }
    const near = nearestMappedLines(scripts, file, line);
    const hint =
      near.length > 0
        ? `Nearest mapped line(s): ${near.join(", ")}. Try one of those`
        : "Try a nearby statement line";
    return new ToolError(
      "no_mapping",
      `'${file}' is source-mapped, but line ${line} has no executable code in the compiled output. ${hint}, or resolve_source_position to probe coordinates.${pendingNote}`,
    );
  }
  const sources = scripts.allOriginalSources();
  if (sources.length === 0) {
    return new ToolError(
      "no_mapping",
      `No source-mapped script matches '${file}:${line}'. No scripts with source maps are loaded yet — if the target just started, maps may still be loading. Try list_scripts to confirm what's loaded.`,
    );
  }
  const base = lastSegment(normalizeSourcePath(file));
  const sameName = new Set(sources.filter((s) => lastSegment(s) === base));
  const ordered = [...sameName, ...sources.filter((s) => !sameName.has(s))];
  const shown = ordered.slice(0, MAX_ECHOED_SOURCES);
  const overflow = ordered.length - shown.length;
  const didYouMean =
    sameName.size > 0 ? ` Did you mean: ${[...sameName].slice(0, MAX_DID_YOU_MEAN).join(", ")}?` : "";
  return new ToolError(
    "no_mapping",
    `No source-mapped script matches '${file}:${line}'.${didYouMean} Mapped sources (${sources.length}): ` +
      `${shown.join(", ")}${overflow > 0 ? ` (+${overflow} more)` : ""}. list_scripts shows per-script detail.${pendingNote}`,
  );
}

// CDP slides a breakpoint to the next executable location when the requested
// line has no code (a blank line, a comment, or a `function foo() {` header).
// That slide is ALSO the fingerprint of a JS line number — read off
// get_script_source (compiled JS) — mistakenly used as a TS line. Compare the
// requested TS line to where CDP actually bound (mapped back to TS) and warn
// when they differ so the agent doesn't silently debug the wrong line. See
// GitHub #46: an agent set a conditional bp at the JS call-site line, which
// resolved onto a loop header where the condition could never be true.
function lineDriftWarning(r: BreakpointRecord): string | undefined {
  // Only compare resolved locations in the SAME source file; a bp that binds
  // into a different original file (unusual) isn't a line-number mix-up.
  const sameFile = r.resolvedLocations.filter((l) => pathMatches(l.file, r.file));
  if (sameFile.length === 0) return undefined; // pending / cross-file — don't guess
  if (sameFile.some((l) => l.line === r.line)) return undefined; // bound where asked
  const boundLines = Array.from(new Set(sameFile.map((l) => l.line))).sort((a, b) => a - b);
  return (
    `Requested ${r.file}:${r.line} but the breakpoint bound at line ${boundLines.join(", ")}. ` +
    `CDP slides a breakpoint to the next executable line, so it pauses at the BOUND line, not the requested one. ` +
    `If this line number came from get_script_source, note that returns compiled JS — set_breakpoint takes TypeScript coordinates; read the TS with get_source to pick the right line.`
  );
}

function breakpointEnvelope(r: BreakpointRecord, status: "set" | "already-set") {
  const warning = lineDriftWarning(r);
  return {
    id: r.id,
    requested: { file: r.file, line: r.line, column: r.column ?? 0 },
    resolved_locations: r.resolvedLocations,
    binding_count: r.bindings.length,
    sessions_bound: Array.from(new Set(r.bindings.map((b) => b.sessionId ?? ROOT_SESSION_KEY))),
    status,
    ...(warning ? { warning } : {}),
  };
}

export function registerBreakpointTools(server: McpServer) {
  registerJsonTool(
    server,
    "set_breakpoint",
    'Set a breakpoint in TypeScript source. Resolves matching scripts via source maps (including in workers and iframes) and binds in each one\'s session. Returns the resolved JS->TS locations. Idempotent at the compiled-location level: re-calling at the same source location — or a different source line the source map collapses onto the same compiled JS position — returns the existing breakpoint id with status: "already-set" (when condition/log_message match). A compiled location already bound with a different condition/log_message, or only partially overlapping an existing breakpoint, returns error: "breakpoint_conflict" — remove the existing breakpoint first.',
    {
      file: z.string().describe("TS file path or fragment (e.g. src/foo.ts)"),
      line: z.number().int().positive().describe("1-based"),
      column: z.number().int().nonnegative().optional(),
      condition: z.string().optional().describe("Expression — pause only when truthy"),
      log_message: z.string().optional().describe("Logpoint: log instead of pausing"),
      session: sessionSchema,
    },
    async (input: { file: string; line: number; column?: number; condition?: string; log_message?: string } & SessionInput) => {
      const s = requireSession(input.session);
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
      const candidates = await mapOriginalToGenerated(s.scripts, file, line, column);
      if (candidates.length === 0) {
        throw noMappingError(s.scripts, file, line, column);
      }
      // Generated-layer idempotency. findBreakpointAt() above matches on the
      // *TS* coordinate, but two different TS lines can minify to the SAME
      // compiled position — and since we bind by `url`, CDP would reject the
      // second with "Breakpoint at specified location already exists" (a
      // non-recoverable internal_error, issue #24). We detect that against what
      // is PHYSICALLY bound — each binding's recorded genKey — not a re-mapping
      // of the live ScriptStore: a script that loads after a record was set
      // (dynamic import / code-split) must not make us claim coverage that was
      // never bound (PR #25 review, finding 1).
      const candKeys = candidates.map(genKey);
      for (const r of s.breakpoints.values()) {
        const boundKeys = new Set(
          r.bindings.map((b) => b.genKey).filter((k): k is string => k !== undefined),
        );
        if (!candKeys.some((k) => boundKeys.has(k))) continue;
        // Full coverage + same condition/log_message → genuinely the same
        // breakpoint. Anything else is recoverable conflict, never a silent
        // partial bind (finding 2): partial overlap means some candidates would
        // still collide in CDP, and a differing condition can't reuse r.
        const fullyCovered = candKeys.every((k) => boundKeys.has(k));
        if (fullyCovered && r.condition === condition && r.logMessage === logMessage) {
          return breakpointEnvelope(r, "already-set");
        }
        const locStr = `${file}:${line}:${column}`;
        const why = fullyCovered
          ? "the same compiled location with a different condition or log_message"
          : "an overlapping compiled location";
        throw new ToolError(
          "breakpoint_conflict",
          `Breakpoint ${r.id} (${r.file}:${r.line}) already binds ${why} as ${locStr}. Remove it first (remove_breakpoint) before setting a new one.`,
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
        // Record the requested spec (genKey) so a later set_breakpoint can tell
        // a real CDP collision from a stale ScriptStore recompute (PR #25 review).
        bindings.push({ cdpId: res.breakpointId, genKey: genKey(c), ...(c.sessionId ? { sessionId: c.sessionId } : {}) });
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
    { id: z.string(), session: sessionSchema },
    async (input: { id: string } & SessionInput) => {
      const s = requireSession(input.session);
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
    { session: sessionSchema },
    async (input: SessionInput) => {
      const s = requireSession(input.session);
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
      session: sessionSchema,
    },
    async (input: { state: "none" | "uncaught" | "all" } & SessionInput) => {
      const s = requireSession(input.session);
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
