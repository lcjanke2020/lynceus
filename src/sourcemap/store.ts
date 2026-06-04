import { SourceMapConsumer } from "@jridgewell/source-map";
import type { Protocol } from "devtools-protocol";
import { normalizeSourcePath, pathMatches } from "./normalize.js";
import { log } from "../util/log.js";

export interface ScriptInfo {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  executionContextId: number;
  hash: string;
  isModule?: boolean;
  // Flat-session ID this script was parsed in. undefined = root/top-level page.
  sessionId?: string;
  consumer?: SourceMapConsumer;
  // Normalized original source paths (from the map).
  sources?: string[];
  loadError?: string;
}

// CDP scriptIds are scoped per Debugger agent (per flat session). Two
// targets — page + worker, or two iframes — can independently emit
// scriptId="42". Keying the store on scriptId alone would let the second
// upsert silently overwrite the first, attach the wrong source map, or
// resolve paused frames to the wrong script. Compound key is sessionId
// (or a synthetic root marker) + scriptId.
const ROOT_KEY = "__root__";
const keyFor = (scriptId: string, sessionId: string | undefined) =>
  `${sessionId ?? ROOT_KEY} ${scriptId}`;

// Indexes scripts the browser has parsed and their (optional) source maps.
export class ScriptStore {
  private byKey = new Map<string, ScriptInfo>();

  // HMR / soft-reload note: when a script is re-parsed under the same
  // (sessionId, scriptId), Object.assign(existing, info) copies the new
  // metadata fields but does NOT overwrite `consumer`, `sources`, or
  // `loadError` because they aren't in the upsert payload (the input type
  // explicitly Omit<>'s them). A subsequent Debugger.scriptParsed for the
  // *same* scriptId therefore inherits the OLD source-map consumer until
  // attachMap() is called again. This is intentional for soft reloads
  // (the source-map URL is usually the same), but means HMR-changed maps
  // can leak stale mappings until the next session reset() clears them.
  // close_session/switchTarget call ScriptStore.clear() so cross-session
  // contamination is bounded — within a session, downstream callers must
  // re-attachMap() after any reload that may have changed the map.
  upsert(info: Omit<ScriptInfo, "consumer" | "sources" | "loadError">) {
    const key = keyFor(info.scriptId, info.sessionId);
    const existing = this.byKey.get(key);
    if (existing) {
      Object.assign(existing, info);
    } else {
      this.byKey.set(key, { ...info });
    }
  }

  get(scriptId: string, sessionId?: string): ScriptInfo | undefined {
    return this.byKey.get(keyFor(scriptId, sessionId));
  }

  all(): ScriptInfo[] {
    return Array.from(this.byKey.values());
  }

  remove(scriptId: string, sessionId?: string) {
    this.byKey.delete(keyFor(scriptId, sessionId));
  }

  clear() {
    for (const s of this.byKey.values()) s.consumer?.destroy();
    this.byKey.clear();
  }

  // Find scripts whose source map references the given TS file.
  findByOriginalSource(file: string): ScriptInfo[] {
    const matches: ScriptInfo[] = [];
    for (const s of this.byKey.values()) {
      if (!s.sources) continue;
      if (s.sources.some((src) => pathMatches(src, file))) {
        matches.push(s);
      }
    }
    return matches;
  }

  attachMap(scriptId: string, sessionId: string | undefined, raw: string, mapUrl?: string): ScriptInfo | null {
    const script = this.byKey.get(keyFor(scriptId, sessionId));
    if (!script) return null;
    try {
      const consumer = new SourceMapConsumer(raw, mapUrl);
      script.consumer = consumer;
      script.sources = (consumer.sources ?? []).map((s) =>
        normalizeSourcePath(s ?? ""),
      );
      script.loadError = undefined;
    } catch (e) {
      script.loadError = `source-map parse failed: ${String(e)}`;
      log.warn("source-map parse failed", { scriptId, sessionId, url: script.url, error: String(e) });
    }
    return script;
  }

  setLoadError(scriptId: string, sessionId: string | undefined, err: string) {
    const s = this.byKey.get(keyFor(scriptId, sessionId));
    if (s) s.loadError = err;
  }
}

// Helpers for converting CDP <-> source-map line numbering.
// CDP: 0-based line, 0-based column.
// source-map: 1-based line, 0-based column.
// Public tool API: 1-based line, 0-based column.

export function cdpToPublic(loc: {
  lineNumber: number;
  columnNumber?: number;
}): { line: number; column: number } {
  return { line: loc.lineNumber + 1, column: loc.columnNumber ?? 0 };
}

export function publicToCdp(loc: {
  line: number;
  column?: number;
}): { lineNumber: number; columnNumber: number } {
  return { lineNumber: loc.line - 1, columnNumber: loc.column ?? 0 };
}

// Translate a CDP-paused frame's location to a public TS location, if a map is available.
export function mapCdpToOriginal(
  store: ScriptStore,
  frame: Pick<Protocol.Debugger.CallFrame["location"], "scriptId" | "lineNumber" | "columnNumber">,
  sessionId: string | undefined,
): { file: string; line: number; column: number } | null {
  const script = store.get(frame.scriptId, sessionId);
  if (!script?.consumer) return null;
  const orig = script.consumer.originalPositionFor({
    line: frame.lineNumber + 1, // source-map is 1-based
    column: frame.columnNumber ?? 0,
  });
  if (orig.source == null || orig.line == null) return null;
  return {
    file: normalizeSourcePath(orig.source),
    line: orig.line, // already 1-based
    column: orig.column ?? 0,
  };
}

export interface GeneratedLocation {
  scriptId: string;
  scriptUrl: string;
  sessionId?: string;
  lineNumber: number;
  columnNumber: number;
}

// Translate a public TS coord to one or more CDP coords for setBreakpointByUrl.
//
// Uses `allGeneratedPositionsFor` (NOT `generatedPositionFor`) because the
// latter requires an EXACT (line, column) match against the source map's
// emitted mappings — and esbuild/vite typically emit mappings only at
// statement starts (e.g., column 2 for an indented `return x;`), not at
// column 0. Setting a breakpoint at `handlers.ts:12` should land regardless
// of whether the caller supplied column 0 (the default) or the exact
// column of the first statement; `allGeneratedPositionsFor` enumerates
// every generated position for the source line, which is the contract
// debuggers want for breakpoint resolution. (PR #11 e2e bug — line 12 of
// the sample app has mappings at columns 2 and 9 but none at column 0.)
//
// If the source line has multiple generated positions across distinct
// generated lines (rare with single-line vite bundles, common after
// minification splits or with classic webpack), each is emitted as its
// own GeneratedLocation — Debugger.setBreakpointByUrl ends up binding at
// each, which is what users intuitively expect.
export function mapOriginalToGenerated(
  store: ScriptStore,
  file: string,
  line: number, // 1-based
  column: number = 0,
): GeneratedLocation[] {
  const out: GeneratedLocation[] = [];
  for (const script of store.findByOriginalSource(file)) {
    if (!script.consumer) continue;
    const sourceKey = pickSourceKey(script, file);
    if (!sourceKey) continue;
    // Forward the caller's column. allGeneratedPositionsFor with column=0
    // returns the first mapping on the source line (the line-broad case
    // set_breakpoint uses by default). With a non-zero column it returns
    // the mapping at-or-after that original column — honoring an
    // explicitly-supplied column without forcing exact-match strictness.
    // (Codex/Opus PR #11 round-2: prior version pinned column:0 here and
    // silently ignored the caller's value.)
    const positions = script.consumer.allGeneratedPositionsFor({
      source: sourceKey,
      line, // 1-based in
      column,
    });
    // De-dup by (gen line, gen col) — different originalColumn mappings on
    // the same source line can collapse to the same generated position
    // after minification, but we only need one breakpoint binding per
    // distinct generated location.
    const seen = new Set<string>();
    for (const gen of positions) {
      if (gen.line == null) continue;
      const key = `${gen.line}:${gen.column ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        scriptId: script.scriptId,
        scriptUrl: script.url,
        ...(script.sessionId ? { sessionId: script.sessionId } : {}),
        lineNumber: gen.line - 1, // back to 0-based for CDP
        columnNumber: gen.column ?? 0,
      });
    }
  }
  return out;
}

function pickSourceKey(script: ScriptInfo, file: string): string | null {
  if (!script.consumer) return null;
  // We want the source as it appears in the map (with whatever prefix it had)
  // so the consumer can look it up.
  for (const raw of script.consumer.sources ?? []) {
    if (raw && pathMatches(raw, file)) return raw;
  }
  return null;
}
