import type CDP from "chrome-remote-interface";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Session } from "../session/state.js";
import { log } from "../util/log.js";

// Build a Debugger.scriptParsed handler that populates the store and lazily
// loads source maps. Pure factory: does NOT call client.on — the caller wires
// it via the unified registerHandler() (which attaches + tracks in one shot).
//
// Takes the whole Session (not just the ScriptStore) so loadSourceMap can
// dispatch fetch-tier by session kind — Node sessions resolve file:// maps
// from disk; browser sessions go through Network.loadNetworkResource. (See the
// session-kind design notes.)
export function buildScriptParsedHandler(
  s: Session,
  sessionId: string | undefined,
): (params: any, eventSessionId?: string) => void {
  return (params: any, eventSessionId?: string) => {
    // Each session sees its own events; gate strictly so root and children
    // don't process each other's. (Strict equality — `if (sessionId && …)`
    // was the original bug: sessionId=undefined made the gate vacuously
    // false, so the root handler ran child events too.)
    if (eventSessionId !== sessionId) return;
    if (!params.url) {
      // anonymous inline scripts — skip; nothing to debug by file path
      return;
    }
    s.scripts.upsert({
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
      void loadSourceMap(s, params.scriptId, params.url, params.sourceMapURL, sessionId);
    }
  };
}

async function loadSourceMap(
  s: Session,
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
      raw = await fetchMap(s, resolved, sessionId);
    }
    s.scripts.attachMap(scriptId, sessionId, raw, mapUrl);
    log.debug("source-map loaded", { scriptUrl, mapUrl });
  } catch (e) {
    s.scripts.setLoadError(scriptId, sessionId, `fetch failed: ${String(e)}`);
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

// Kind-aware dispatch. Browser sessions hit the page's network stack so
// auth/cookies/dev-server middleware apply; Node sessions skip that entirely
// (the Network domain doesn't exist there) and read file:// URLs from disk.
// (See the session-kind design notes.)
async function fetchMap(
  s: Session,
  url: string,
  sessionId: string | undefined,
): Promise<string> {
  if (s.kind === "node") return await fetchMapNode(s, url);
  // s.kind === "browser" — client is always set when a scriptParsed event
  // fires, since the handler was wired AFTER CDP attach.
  return await fetchMapBrowser(s.client!, url, sessionId);
}

// chromeHost=null means default-to-localhost (per state.ts comment).
// attach_node always sets it explicitly to one of these strings or the
// user-provided host. Conservative exact-match: 127.0.0.2 etc. would also
// be loopback but require deliberate opt-in we can't reasonably guess at.
function isLoopbackHost(host: string | null): boolean {
  return host === null || host === "127.0.0.1" || host === "::1" || host === "localhost";
}

async function fetchMapNode(s: Session, url: string): Promise<string> {
  if (url.startsWith("file://")) {
    // Refuse file:// reads for non-loopback Node sessions. The script URL
    // is the path on the remote machine — it almost certainly doesn't exist
    // locally, and a malicious remote could choose paths that DO (e.g.
    // /etc/passwd) and trick us into reading them. Copy build artifacts
    // locally or use a tunnel for remote Node debugging. (Copilot PR-review
    // on #70.)
    if (!isLoopbackHost(s.chromeHost)) {
      throw new Error(
        `Refusing to read file:// source map for remote Node session (host=${s.chromeHost}). ` +
          `Remote file:// source maps aren't supported — the path is on the remote machine and ` +
          `reading it locally would either fail or load the wrong file. Copy the build artifacts ` +
          `to this host or run an SSH tunnel.`,
      );
    }
    // Probe (Node v24.13.1, 2026-05-20): tsc --sourceMap emits a relative
    // sourceMappingURL ("index.js.map") that new URL() resolves against the
    // file:// scriptUrl. fileURLToPath then gives the on-disk path.
    return await readFile(fileURLToPath(url), "utf8");
  }
  // Rare: Node process whose sourceMappingURL points at a dev-server bundle.
  // Plain fetch — no browser context to inherit.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function fetchMapBrowser(
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
