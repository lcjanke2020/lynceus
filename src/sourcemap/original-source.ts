import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Session } from "../session/state.js";
import type { ScriptInfo } from "./store.js";
import { pickSourceKey, waitForConsumer, MAP_LOAD_WAIT_MS } from "./store.js";
import { isLoopbackHost } from "./loader.js";
import { normalizeSourcePath } from "./normalize.js";

// Where the returned TypeScript text came from. `source_map` = the map
// embedded the original via `sourcesContent` (the browser / vite / esbuild
// default); `disk` = the map only listed `sources` (the `tsc --sourceMap`
// default) so we read the .ts off the local filesystem.
export type OriginalSourceOrigin = "source_map" | "disk";

export interface OriginalSource {
  /** Normalized source path as the map lists it (e.g. "src/foo.ts"). */
  file: string;
  content: string;
  scriptId: string;
  sessionId: string | null;
  scriptUrl: string;
  origin: OriginalSourceOrigin;
}

export type OriginalSourceResult =
  | { ok: true; value: OriginalSource }
  // no map references the file at all — the agent asked for the wrong path,
  // or the script hasn't parsed yet.
  | { ok: false; reason: "no_match" }
  // a map DOES reference the file, but its original text is neither embedded
  // (`sourcesContent`) nor readable from disk (non-loopback, or the file moved).
  | { ok: false; reason: "no_content" };

// Resolve the ORIGINAL TypeScript source for a TS `file` fragment, the
// counterpart to get_script_source (which only returns compiled JS). Tries the
// source map's embedded `sourcesContent` first (no I/O), then falls back to
// reading the .ts from disk for a loopback session.
//
// The disk read is gated on loopback exactly like loader.ts's file:// source-map
// read — the same rationale applies: for a non-loopback session the path is on
// another machine, so reading it locally would either miss or (with an
// attacker-chosen path) load the wrong file.
export async function readOriginalSource(
  s: Session,
  file: string,
  sessionId?: string | null,
): Promise<OriginalSourceResult> {
  // A map matching `file` may still be in flight right after the Node entry
  // pause (loadSourceMap is fire-and-forget) — poll briefly, giving up early
  // if nothing's pending. Mirrors mapOriginalToGenerated's slow path.
  await waitForConsumer(
    s.scripts,
    () => s.scripts.findByOriginalSource(file).length > 0,
    Date.now() + MAP_LOAD_WAIT_MS,
  );
  let matches = s.scripts.findByOriginalSource(file);
  // When session_id is supplied, restrict to that session's scripts so a
  // worker/iframe copy is disambiguated from the root's (CDP scriptIds and
  // sources collide across sessions). `undefined` (omitted) means "don't
  // filter"; `null` means the root explicitly.
  if (sessionId !== undefined) {
    const want = sessionId ?? undefined;
    matches = matches.filter((sc) => sc.sessionId === want);
  }
  if (matches.length === 0) return { ok: false, reason: "no_match" };

  let sawCandidate = false;
  for (const script of matches) {
    if (!script.consumer) continue;
    const rawKey = pickSourceKey(script, file);
    if (!rawKey) continue;
    sawCandidate = true;

    // 1) Embedded original source — the common browser / bundler case.
    const embedded = script.consumer.sourceContentFor(rawKey, /* nullOnMissing */ true);
    if (embedded != null) {
      return { ok: true, value: makeValue(script, rawKey, embedded, "source_map") };
    }

    // 2) Disk fallback. `tsc --sourceMap` (default) emits `sources` but no
    //    `sourcesContent`, so the .ts is only on disk. Resolve the raw source
    //    against the map URL and read it — loopback file:// only.
    const diskUrl = resolveSourceUrl(script, rawKey);
    if (diskUrl && diskUrl.startsWith("file://") && isLoopbackHost(s.chromeHost)) {
      try {
        const content = await readFile(fileURLToPath(diskUrl), "utf8");
        return { ok: true, value: makeValue(script, rawKey, content, "disk") };
      } catch {
        // Try the next matching script (a different bundle may embed content).
      }
    }
  }
  return { ok: false, reason: sawCandidate ? "no_content" : "no_match" };
}

function makeValue(
  script: ScriptInfo,
  rawKey: string,
  content: string,
  origin: OriginalSourceOrigin,
): OriginalSource {
  return {
    file: normalizeSourcePath(rawKey),
    content,
    scriptId: script.scriptId,
    sessionId: script.sessionId ?? null,
    scriptUrl: script.url,
    origin,
  };
}

// Resolve the map's raw source path (e.g. "../src/foo.ts") to an absolute URL
// using the SAME base the SourceMapConsumer used: the map URL (the script's
// sourceMapURL resolved against the script URL). For an inline (data:) map the
// base is the script URL itself. Already-absolute sources pass through.
function resolveSourceUrl(script: ScriptInfo, rawSource: string): string | null {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawSource)) return new URL(rawSource).toString();
    const smu = script.sourceMapURL;
    const base =
      smu && !smu.startsWith("data:") ? new URL(smu, script.url).toString() : script.url;
    return new URL(rawSource, base).toString();
  } catch {
    return null;
  }
}
