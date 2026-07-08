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
  /** Embed the original TS text in the map (`sourcesContent`). Omit for a
   *  `tsc --sourceMap`-style map that carries `sources` but no content. */
  sourceContent?: string;
  /** Source map URL to parse the map against (resolves relative `sources`). */
  sourceMapURL?: string;
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
    ...(opts.sourceMapURL ? { sourceMapURL: opts.sourceMapURL } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  const gen = new SourceMapGenerator({ file: opts.url });
  gen.addMapping({
    generated: { line: jsLine, column: 0 },
    original: { line: tsLine, column: 0 },
    source: opts.source,
  });
  if (opts.sourceContent !== undefined) gen.setSourceContent(opts.source, opts.sourceContent);
  // No mapUrl here so the consumer keeps `sources` as-given (relative) — the
  // disk-fallback path then resolves them via ScriptInfo.sourceMapURL + url,
  // mirroring the production branch where consumer.sources aren't pre-resolved.
  sessionState.scripts.attachMap(opts.scriptId, opts.sessionId, gen.toString());
  return { tsLine, jsLine };
}
