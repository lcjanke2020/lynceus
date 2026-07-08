import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Protocol } from "devtools-protocol";
import { requireSession, requirePaused } from "../session/state.js";
import { mapCdpToOriginal } from "../sourcemap/store.js";
import { describeRemote, previewRemoteObject } from "../util/format.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";

// session_id provenance: objectIds, callFrameIds, and scriptIds returned by
// CDP are scoped per-session (per-target). The inspect tools attach
// `session_id` to every returned remote-object so the agent can pass it back
// to get_object_properties and route to the correct Runtime agent.

export function registerInspectTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_call_stack",
    "Get the current call stack with TS-mapped frames. Only valid while paused. Each frame includes the session_id its Runtime/Debugger agent belongs to — pass it through to evaluate/get_object_properties for the right routing.",
    undefined,
    async () => {
      const s = requirePaused();
      const state = s.pause.current()!;
      const sid = state.sessionId;
      return state.callFrames.map((cf, i) => {
        const mapped = mapCdpToOriginal(s.scripts, cf.location, sid);
        const script = s.scripts.get(cf.location.scriptId, sid);
        return {
          index: i,
          frame_id: cf.callFrameId,
          session_id: sid ?? null,
          function_name: cf.functionName || "(anonymous)",
          file: mapped?.file ?? script?.url ?? cf.url ?? "<unknown>",
          line: mapped?.line ?? cf.location.lineNumber + 1,
          column: mapped?.column ?? cf.location.columnNumber ?? 0,
          js_url: script?.url,
          js_line: cf.location.lineNumber + 1,
          scope_types: cf.scopeChain.map((sc) => sc.type),
        };
      });
    },
  );

  registerJsonTool(
    server,
    "get_scope",
    "Return variables visible at a paused frame. Valid only while paused. With no scope_type, returns the merged lexical view — the innermost block/catch/with scopes plus the function's local scope, innermost binding winning on name shadowing — so block-scoped let/loop variables (e.g. a `for (let i…)` counter) are included; this mirrors the DevTools 'Local' pane. Pass a specific scope_type to read exactly one scope. To read a single value no matter which scope holds it, `evaluate` resolves against the whole frame scope chain. Each item includes the session_id of the originating Runtime agent — required for follow-on get_object_properties calls when paused in a worker/iframe.",
    {
      frame_index: z.number().int().nonnegative().optional().describe("Default 0 (topmost frame)"),
      scope_type: z
        .enum(["local", "closure", "global", "block", "catch", "with", "script", "eval", "module"])
        .optional()
        .describe(
          "Omit for the merged lexical view (inner block/catch/with + function local, innermost wins); set one type to read exactly that scope.",
        ),
      max_props: z.number().int().positive().optional(),
    },
    async (input: { frame_index?: number; scope_type?: string; max_props?: number }) => {
      const s = requirePaused();
      const state = s.pause.current()!;
      const sid = state.sessionId;
      const idx = input.frame_index ?? 0;
      const frame = state.callFrames[idx];
      if (!frame) throw new ToolError("bad_frame", `Frame ${idx} out of range (${state.callFrames.length} frames)`);
      const max = input.max_props ?? 50;

      // Fetch a scope object's properties (raw CDP descriptors, symbols
      // included so `truncated` counts the way it always has).
      const fetchRaw = async (objectId: string): Promise<Protocol.Runtime.PropertyDescriptor[]> => {
        const result = await s.client!.send(
          "Runtime.getProperties",
          {
            objectId,
            ownProperties: false,
            accessorPropertiesOnly: false,
            generatePreview: true,
          },
          sid,
        );
        return result.result ?? [];
      };
      const toItem = (p: Protocol.Runtime.PropertyDescriptor) => ({
        name: p.name,
        ...(p.value ? describeRemote(p.value) : { type: "missing", preview: "(no value)" }),
        session_id: sid ?? null,
        writable: p.writable,
        enumerable: p.enumerable,
      });

      // Explicit scope_type: read exactly that one scope (behavior unchanged).
      if (input.scope_type) {
        const scope = frame.scopeChain.find((sc) => sc.type === input.scope_type);
        if (!scope?.object?.objectId) {
          throw new ToolError(
            "no_scope",
            `Frame ${idx} has no '${input.scope_type}' scope. Available: ${frame.scopeChain
              .map((sc) => sc.type)
              .join(", ")}`,
          );
        }
        const raw = await fetchRaw(scope.object.objectId);
        return {
          frame_index: idx,
          scope_type: input.scope_type,
          session_id: sid ?? null,
          items: raw.filter((p) => !p.symbol).slice(0, max).map(toItem),
          truncated: raw.length > max,
        };
      }

      // Default: merge the innermost contiguous lexical scopes (block/catch/
      // with) plus the function local scope, innermost binding winning on
      // shadowing — mirrors the DevTools "Local" pane. A single-scope read
      // silently misses `for (let i…)` loop variables: they live in a block
      // scope, not `local`, and with nested blocks not even the innermost
      // block. Stop at the first non-lexical scope (closure/global/script/…),
      // which is where enclosing (not currently-visible-as-local) bindings
      // begin.
      const LEXICAL_SCOPES: ReadonlySet<string> = new Set(["block", "catch", "with", "local"]);
      const lexicalScopes: typeof frame.scopeChain = [];
      for (const sc of frame.scopeChain) {
        if (!LEXICAL_SCOPES.has(sc.type)) break;
        lexicalScopes.push(sc);
      }
      if (lexicalScopes.length === 0) {
        throw new ToolError(
          "no_scope",
          `Frame ${idx} has no local/block scope. Available: ${frame.scopeChain
            .map((sc) => sc.type)
            .join(", ")}`,
        );
      }
      const seen = new Set<string>();
      const merged: Protocol.Runtime.PropertyDescriptor[] = [];
      for (const sc of lexicalScopes) {
        if (!sc.object?.objectId) continue;
        for (const p of await fetchRaw(sc.object.objectId)) {
          if (p.symbol || seen.has(p.name)) continue; // innermost binding wins
          seen.add(p.name);
          merged.push(p);
        }
      }
      return {
        frame_index: idx,
        scope_type: "local",
        merged_scope_types: lexicalScopes.map((sc) => sc.type),
        session_id: sid ?? null,
        items: merged.slice(0, max).map(toItem),
        truncated: merged.length > max,
      };
    },
  );

  registerJsonTool(
    server,
    "evaluate",
    "Evaluate a JS expression. When the debugger is paused, the expression runs in the paused frame's context via Debugger.evaluateOnCallFrame (top frame by default; override with frame_index) — resolving against the frame's entire scope chain, including block-scoped/let variables, so it reads values a single get_scope may not surface. When not paused, runs in the page's Runtime context via Runtime.evaluate. frame_index given while not paused is a not_paused error. Note: while paused the event loop is frozen, so async expressions return the unresolved Promise object rather than awaiting it.",
    {
      expression: z.string(),
      frame_index: z.number().int().nonnegative().optional(),
      return_by_value: z.boolean().optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
    async (input: {
      expression: string;
      frame_index?: number;
      return_by_value?: boolean;
      timeout_ms?: number;
    }) => {
      const s = requireSession();
      const paused = s.pause.isPaused();
      if (input.frame_index !== undefined && !paused) {
        throw new ToolError("not_paused", "frame_index requires paused state");
      }
      if (paused) {
        const state = s.pause.current()!;
        const sid = state.sessionId;
        const idx = input.frame_index ?? 0;
        const frame = state.callFrames[idx];
        if (!frame) throw new ToolError("bad_frame", `Frame ${idx} out of range (${state.callFrames.length} frames)`);
        const res = await s.client!.send(
          "Debugger.evaluateOnCallFrame",
          {
            callFrameId: frame.callFrameId,
            expression: input.expression,
            returnByValue: !!input.return_by_value,
            generatePreview: true,
            throwOnSideEffect: false,
            ...(input.timeout_ms ? { timeout: input.timeout_ms } : {}),
          },
          sid,
        );
        return formatEvalResult(res.result, res.exceptionDetails, sid);
      }
      const res = await s.client!.send("Runtime.evaluate", {
        expression: input.expression,
        returnByValue: !!input.return_by_value,
        generatePreview: true,
        awaitPromise: true,
        ...(input.timeout_ms ? { timeout: input.timeout_ms } : {}),
      });
      return formatEvalResult(res.result, res.exceptionDetails, undefined);
    },
  );

  registerJsonTool(
    server,
    "get_object_properties",
    "Inspect a RemoteObject by ID (from get_scope, evaluate, or a callstack frame). Pass `session_id` from the source response so the call routes to the right Runtime agent — null or omitted means root.",
    {
      object_id: z.string(),
      session_id: z.string().nullable().optional().describe("From get_scope/evaluate/get_call_stack response. null or omitted = root."),
      own_only: z.boolean().optional().describe("Default true"),
      max_props: z.number().int().positive().optional(),
    },
    async (input: { object_id: string; session_id?: string | null; own_only?: boolean; max_props?: number }) => {
      const s = requireSession();
      // Strict provenance: omitted session_id means root. The previous
      // "fall back to the paused session" behavior misrouted any
      // root-minted objectId once a child session was paused — a root
      // `evaluate` response carries no session_id (JSON drops undefined),
      // so an agent could not pass it back, and the fallback then
      // dispatched against the wrong target.
      // null is the explicit "root" sentinel agents round-trip from responses;
      // CDP wants undefined for root.
      const sid = input.session_id ?? undefined;
      const max = input.max_props ?? 50;
      const ownProperties = input.own_only ?? true;
      const result = await s.client!.send(
        "Runtime.getProperties",
        {
          objectId: input.object_id,
          ownProperties,
          accessorPropertiesOnly: false,
          generatePreview: true,
        },
        sid,
      );
      return {
        session_id: sid ?? null,
        items: (result.result ?? [])
          .filter((p) => !p.symbol)
          .slice(0, max)
          .map((p) => ({
            name: p.name,
            ...(p.value ? describeRemote(p.value) : { type: "missing", preview: "(no value)" }),
            session_id: sid ?? null,
            writable: p.writable,
            enumerable: p.enumerable,
          })),
        truncated: (result.result?.length ?? 0) > max,
      };
    },
  );
}

function formatEvalResult(
  result: Protocol.Runtime.RemoteObject,
  exceptionDetails: Protocol.Runtime.ExceptionDetails | undefined,
  sessionId: string | undefined,
) {
  // Emit session_id as `null` for root (not undefined) so it survives JSON
  // serialization. Agents need a value to round-trip into
  // get_object_properties — otherwise a root-evaluate response with no
  // session_id field has nothing for the agent to pass back, and any
  // omit-then-default fallback misroutes when a child session is paused.
  const sid = sessionId ?? null;
  if (exceptionDetails) {
    return {
      error: true,
      message: exceptionDetails.exception?.description ?? exceptionDetails.text,
      ...(exceptionDetails.exception?.objectId ? { object_id: exceptionDetails.exception.objectId } : {}),
      session_id: sid,
    };
  }
  return {
    type: result.subtype ?? result.type,
    preview: previewRemoteObject(result),
    value: "value" in result ? result.value : undefined,
    ...(result.objectId ? { object_id: result.objectId } : {}),
    session_id: sid,
  };
}
