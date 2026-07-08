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
  // Omitting session_id — like an explicit null — means the ROOT target,
  // matching the repo-wide session_id convention and get_script_source. NOT
  // "search every session": that let a worker/iframe copy of the same TS path
  // shadow the root (codex review — omitted returned the worker source while an
  // explicit null returned root). Pass a session_id to read a child's copy.
  const want = sessionId ?? undefined;
  // A map matching `file` in the TARGET session may still be in flight right
  // after the Node entry pause (loadSourceMap is fire-and-forget) — poll
  // briefly, giving up early if nothing's pending. The predicate MUST apply the
  // same session filter as the match below: otherwise another session's
  // already-loaded copy of `file` satisfies the wait and we return no_match
  // before the target session's map attaches (codex round-2 review).
  await waitForConsumer(
    s.scripts,
    () => s.scripts.findByOriginalSource(file).some((sc) => sc.sessionId === want),
    Date.now() + MAP_LOAD_WAIT_MS,
  );
  const matches = s.scripts.findByOriginalSource(file).filter((sc) => sc.sessionId === want);
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

    // 2) Disk fallback — NODE sessions only. `tsc --sourceMap` (default) emits
    //    `sources` without `sourcesContent`, and for a loopback Node session
    //    the .ts is a local build artifact we can read (mirrors loader.ts's
    //    Node-only file:// source-map read). We must NOT read disk for a
    //    browser session: the page and its source maps are (potentially
    //    untrusted) HTTP content, so a malicious map advertising e.g.
    //    `sources: ["file:///etc/passwd"]` would otherwise turn get_source into
    //    an arbitrary local-file read on the developer's machine (codex +
    //    Copilot review). A browser map without sourcesContent just yields
    //    no_content — the agent falls back to get_script_source.
    const diskUrl = resolveSourceUrl(script, rawKey);
    if (
      diskUrl &&
      diskUrl.startsWith("file://") &&
      s.kind === "node" &&
      isLoopbackHost(s.chromeHost)
    ) {
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
    // Already-absolute source (has a "scheme://" — file://, webpack://,
    // http://, …) passes through unchanged; relative sources resolve against
    // the map URL below.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawSource)) return new URL(rawSource).toString();
    const smu = script.sourceMapURL;
    const base =
      smu && !smu.startsWith("data:") ? new URL(smu, script.url).toString() : script.url;
    return new URL(rawSource, base).toString();
  } catch {
    return null;
  }
}
