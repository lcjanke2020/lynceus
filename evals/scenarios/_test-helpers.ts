// Shared synthetic-trace helpers for scenario oracle tests. Underscored
// so the scenarios/index.ts auto-discovery (if it ever gains one) skips
// this file.

import type { TraceEntry } from "../harness/types.js";

export function call(toolUseId: string, tool: string, input: unknown): TraceEntry {
  return { t: "tool_call", ts: "x", iter: 1, toolUseId, tool, input };
}

export function result(
  toolUseId: string,
  tool: string,
  isError: boolean,
  output: unknown,
  errorCode?: string,
): TraceEntry {
  return {
    t: "tool_result",
    ts: "x",
    iter: 1,
    toolUseId,
    tool,
    isError,
    output,
    ...(errorCode ? { errorCode } : {}),
  };
}

/** Convenience: emit a paired tool_call + tool_result. */
export function pair(
  id: string,
  tool: string,
  input: unknown,
  output: unknown,
  isError = false,
  errorCode?: string,
): TraceEntry[] {
  return [call(id, tool, input), result(id, tool, isError, output, errorCode)];
}
