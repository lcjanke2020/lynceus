// Build a tiny synthetic source map and pre-populate ScriptStore for L2 tests
// that need set_breakpoint / resolve_source_position / list_scripts to find
// source-mapped candidates. Reusing this avoids re-deriving SourceMapGenerator
// usage in every per-tool test file.

import { SourceMapGenerator } from "@jridgewell/source-map";
import { sessionState } from "../../src/session/state.js";

/**
 * Adds a script to sessionState.scripts with a one-mapping source map.
 * Returns the (publicly observable) source-map fields so tests can build
 * meaningful assertions.
 *
 * Default mapping: TS line 7 col 0 -> JS line 1 col 0 of the generated file.
 */
export function seedMappedScript(opts: {
  scriptId: string;
  url: string;
  source: string; // e.g. "src/handlers.ts"
  sessionId?: string;
  /** TS line in the original source (1-based). Default 7. */
  tsLine?: number;
  /** JS line in the generated source (1-based for source-map). Default 1. */
  jsLine?: number;
}) {
  const tsLine = opts.tsLine ?? 7;
  const jsLine = opts.jsLine ?? 1;
  sessionState.scripts.upsert({
    scriptId: opts.scriptId,
    url: opts.url,
    startLine: 0,
    startColumn: 0,
    endLine: 100,
    endColumn: 0,
    executionContextId: 1,
    hash: `h-${opts.scriptId}`,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  const gen = new SourceMapGenerator({ file: opts.url });
  gen.addMapping({
    generated: { line: jsLine, column: 0 },
    original: { line: tsLine, column: 0 },
    source: opts.source,
  });
  sessionState.scripts.attachMap(opts.scriptId, opts.sessionId, gen.toString());
  return { tsLine, jsLine };
}
