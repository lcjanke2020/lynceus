import type CDP from "chrome-remote-interface";
import { ScriptStore } from "./store.js";
import { log } from "../util/log.js";

// Wire up Debugger.scriptParsed to populate the store and lazily load source maps.
// Returns the registered handler so the caller can later `client.removeListener("Debugger.scriptParsed", handler)`.
export function attachScriptListener(
  client: CDP.Client,
  store: ScriptStore,
  sessionId: string | undefined,
): (params: any, eventSessionId?: string) => void {
  const handler = (params: any, eventSessionId?: string) => {
    // Each session sees its own events; gate strictly so root and children
    // don't process each other's. (Strict equality — `if (sessionId && …)`
    // was the original bug: sessionId=undefined made the gate vacuously
    // false, so the root handler ran child events too.)
    if (eventSessionId !== sessionId) return;
    if (!params.url) {
      // anonymous inline scripts — skip; nothing to debug by file path
      return;
    }
    store.upsert({
      scriptId: params.scriptId,
      url: params.url,
      sourceMapURL: params.sourceMapURL || undefined,
      startLine: params.startLine,
      startColumn: params.startColumn,
      endLine: params.endLine,
      endColumn: params.endColumn,
      executionContextId: params.executionContextId,
      hash: params.hash,
      isModule: params.isModule,
      ...(sessionId ? { sessionId } : {}),
    });
    if (params.sourceMapURL) {
      void loadSourceMap(client, store, params.scriptId, params.url, params.sourceMapURL, sessionId);
    }
  };
  client.on("Debugger.scriptParsed", handler);
  return handler;
}

async function loadSourceMap(
  client: CDP.Client,
  store: ScriptStore,
  scriptId: string,
  scriptUrl: string,
  sourceMapURL: string,
  sessionId: string | undefined,
) {
  try {
    let raw: string;
    let mapUrl: string | undefined;
    if (sourceMapURL.startsWith("data:")) {
      raw = decodeDataUri(sourceMapURL);
      mapUrl = scriptUrl;
    } else {
      const resolved = new URL(sourceMapURL, scriptUrl).toString();
      mapUrl = resolved;
      raw = await fetchMap(client, resolved, sessionId);
    }
    store.attachMap(scriptId, sessionId, raw, mapUrl);
    log.debug("source-map loaded", { scriptUrl, mapUrl });
  } catch (e) {
    store.setLoadError(scriptId, sessionId, `fetch failed: ${String(e)}`);
    log.warn("source-map fetch failed", { scriptUrl, sourceMapURL, error: String(e) });
  }
}

// Decode a data: URI body, supporting the RFC 2397 multi-parameter form
// (`data:<type>;charset=utf-8;base64,…`) that webpack's `inline-source-map`
// devtool emits. The previous `[^,;]*` regex rejected anything with extra
// parameters between the type and `;base64`, so webpack-inlined source maps
// never loaded and TS-aware tools silently degraded to JS coords.
export function decodeDataUri(uri: string): string {
  if (!uri.startsWith("data:")) throw new Error("Not a data URI");
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("Malformed data URI (no comma)");
  const meta = uri.slice(5, comma); // between `data:` and `,`
  const payload = uri.slice(comma + 1);
  if (!payload) throw new Error("Empty data URI payload");
  const params = meta.split(";");
  const isBase64 = params.includes("base64");
  if (isBase64) return Buffer.from(payload, "base64").toString("utf8");
  return decodeURIComponent(payload);
}

async function fetchMap(
  client: CDP.Client,
  url: string,
  sessionId: string | undefined,
): Promise<string> {
  // Prefer using the browser's network stack so we go through the page's
  // origin/CORS context (cookies, auth, dev-server middleware).
  //
  // CDP docs: `Network.loadNetworkResource.frameId` is "Mandatory for frame
  // targets, and should be omitted for worker targets." Without it, the
  // preferred browser-context path fails for page scripts and silently
  // falls back to Node fetch — which works for plain localhost but loses
  // the auth/cookie/origin context we actually want.
  //
  // Strategy: opportunistically resolve the top frame id via Page domain.
  // It succeeds on page/OOPIF sessions, throws on worker sessions where
  // Page is unavailable — exactly the two cases CDP wants us to handle.
  let frameId: string | undefined;
  try {
    const tree = await client.Page.getFrameTree(sessionId);
    frameId = tree.frameTree.frame.id;
  } catch {
    // Worker / service-worker session — Page domain unavailable; omit frameId.
  }
  try {
    const { resource } = await client.Network.loadNetworkResource(
      {
        ...(frameId ? { frameId } : {}),
        url,
        // includeCredentials: true — the whole point of the browser-context
        // path is to inherit the page's auth (cookies, sessions, dev-server
        // middleware). false would defeat the intent and bounce
        // session-protected source maps back to the credential-less Node
        // fetch fallback.
        options: { disableCache: false, includeCredentials: true },
      },
      sessionId,
    );
    if (!resource?.success || !resource.stream) {
      throw new Error(`loadNetworkResource failed: ${resource?.netError ?? resource?.httpStatusCode}`);
    }
    const first = await client.IO.read({ handle: resource.stream }, sessionId);
    let combined = first.base64Encoded ? Buffer.from(first.data, "base64").toString("utf8") : first.data;
    let eof = first.eof;
    while (!eof) {
      const next = await client.IO.read({ handle: resource.stream }, sessionId);
      combined += next.base64Encoded ? Buffer.from(next.data, "base64").toString("utf8") : next.data;
      eof = next.eof;
    }
    try {
      await client.IO.close({ handle: resource.stream }, sessionId);
    } catch {
      /* ignore */
    }
    return combined;
  } catch (browserErr) {
    // Fallback: fetch directly from Node — works for localhost dev servers.
    log.debug("loadNetworkResource failed, falling back to Node fetch", { url, error: String(browserErr) });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  }
}
