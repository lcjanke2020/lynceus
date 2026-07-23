import { mkdirSync } from "node:fs";
import CDP from "chrome-remote-interface";
import { launch, type LaunchedChrome, type Options as LaunchOptions } from "chrome-launcher";
import type { Protocol } from "devtools-protocol";
import {
  registry,
  registerHandler,
  ROOT_SESSION_KEY,
  type PreDocumentScriptRecord,
  type PreDocumentScriptSpec,
  type Session,
} from "./state.js";
import { connectDebugger } from "./debugger.js";
import { log } from "../util/log.js";
import { snapUserDataDir } from "../util/browser-resolve.js";

export interface LaunchArgs {
  url?: string;
  headless?: boolean;
  userDataDir?: string;
  args?: string[];
  // Optional explicit binary path. When omitted, chrome-launcher auto-detects
  // (Linux: searches PATH for google-chrome-stable, google-chrome,
  // chromium-browser, chromium). Set this only when auto-detection fails or
  // when overriding for a specific binary (e.g. snap-installed Chromium that
  // needs the snap user-data-dir workaround). Forwards to chrome-launcher's
  // own `chromePath` option.
  chromePath?: string;
  // Whether to enable Chromium's sandbox. Default `false` — we add
  // `--no-sandbox` to chromeFlags. Rationale: on Ubuntu 23.10+ (24.04+)
  // AppArmor restricts unprivileged user namespaces, which Chromium's
  // sandbox relies on; without a SUID `chrome_sandbox` helper, Chromium
  // FATALs at startup and chrome-launcher's port-poll loop times out with
  // ECONNREFUSED. The MCP server already exposes broad page-control
  // primitives to its caller (Runtime.evaluate, Debugger.*, DOM driving),
  // so the per-process sandbox isn't the trust boundary anyway. Set to
  // `true` only on a host that has a working sandbox path (AppArmor
  // userns allowance or SUID helper) AND you want to test sandbox-on.
  sandbox?: boolean;
  // Optional friendly session label (design §3), unique among live sessions.
  label?: string;
}

export interface AttachArgs {
  port?: number;
  host?: string;
  targetFilter?: { type?: string; urlIncludes?: string };
  // Optional friendly session label (design §3), unique among live sessions.
  label?: string;
}

const DEFAULT_PORT = 9222;

/**
 * Register a script before future documents execute and retain the logical
 * definition on the owning browser SessionState. The root Page agent's CDP
 * identifier becomes the stable logical id; child Page agents mint their own
 * identifiers, recorded in `installations` for PR 1b's detach lifecycle.
 */
export async function addPreDocumentScript(
  s: Session,
  spec: PreDocumentScriptSpec,
): Promise<PreDocumentScriptRecord> {
  if (s.kind !== "browser") {
    throw new Error("Pre-document scripts require a browser session");
  }
  const client = s.client;
  if (!client) throw new Error("Cannot add a pre-document script without an active CDP client");

  // Clone + freeze the definition so caller-side mutation cannot change what
  // future child sessions receive.
  const storedSpec = Object.freeze({ ...spec });
  const root = await client.Page.addScriptToEvaluateOnNewDocument(storedSpec);
  const record: PreDocumentScriptRecord = {
    id: root.identifier,
    spec: storedSpec,
    installations: new Map([[ROOT_SESSION_KEY, root.identifier]]),
  };
  s.preDocumentScripts.set(record.id, record);

  // A script can be registered after auto-attach has already discovered
  // OOPIFs. Apply it to every currently tracked child as well; targets whose
  // Page domain does not support this command (for example workers) are
  // intentionally best-effort and will receive future generic Runtime
  // primitives through their own adapter path instead.
  for (const key of s.sessionHandlers.keys()) {
    if (key === ROOT_SESSION_KEY) continue;
    await installPreDocumentScript(s, client, record, key, true);
  }
  return record;
}

async function installPreDocumentScript(
  s: Session,
  client: import("chrome-remote-interface").Client,
  record: PreDocumentScriptRecord,
  sessionId: string | undefined,
  bestEffort: boolean,
): Promise<void> {
  const key = sessionId ?? ROOT_SESSION_KEY;
  if (record.installations.has(key)) return;
  try {
    const result = await client.Page.addScriptToEvaluateOnNewDocument(record.spec, sessionId);
    // The target may have detached while the command was in flight. Do not
    // resurrect a stale child installation after detachSession removed it.
    if (sessionId === undefined || s.sessionHandlers.has(sessionId)) {
      record.installations.set(key, result.identifier);
    }
  } catch (e) {
    if (!bestEffort) throw e;
    log.warn("failed to replay pre-document script", {
      scriptId: record.id,
      sessionId: sessionId ?? null,
      error: String(e),
    });
  }
}

async function replayPreDocumentScripts(
  s: Session,
  client: import("chrome-remote-interface").Client,
  sessionId: string | undefined,
  bestEffort: boolean,
): Promise<void> {
  for (const record of s.preDocumentScripts.values()) {
    await installPreDocumentScript(s, client, record, sessionId, bestEffort);
  }
}

export async function launchChrome(opts: LaunchArgs = {}): Promise<{
  session: string;
  label: string | null;
  targetId: string;
  url: string;
}> {
  // Per-kind capacity + label uniqueness now live inside registry.reserve().
  // Everything after the reservation runs under reserve → activate/abort so a
  // failed launch frees the slot instead of leaving a ghost record.
  const rec = registry.reserve("browser", opts.label);
  const s = rec.state;
  try {
    // chrome-launcher manages --remote-debugging-port itself: it picks an
    // unused port, adds the flag, and polls it. Passing our own
    // --remote-debugging-port=0 in chromeFlags appears AFTER chrome-launcher's,
    // and since Chrome honors the last occurrence, Chrome picks an ephemeral
    // port written to DevToolsActivePort while chrome-launcher polls its own
    // (stale) port → ECONNREFUSED on every connect. Don't pass it; let
    // chrome-launcher own port selection. `runningChrome.port` then reflects
    // the actual port Chrome is listening on. (Codex blocker review on PR #11.)
    // Sandbox decision: an explicit `sandbox` arg from the caller always wins.
    // When the caller omits it, fall back to the CDP_SANDBOX env (default off);
    // "true" or "1" enable it (matching the eval runner's EVAL_SANDBOX parsing).
    // This lets a host with a working sandbox path opt a whole run into
    // sandbox-on (e.g. the L4 eval runner via EVAL_SANDBOX → CDP_SANDBOX)
    // without prompt-injecting every launch_chrome call. Unset env → false →
    // the --no-sandbox automation default (unchanged). Explicit `sandbox: false`
    // still forces --no-sandbox even if the env is set.
    const sandboxEnv = process.env.CDP_SANDBOX;
    const useSandbox = opts.sandbox ?? (sandboxEnv === "true" || sandboxEnv === "1");
    const userArgs = opts.args ?? [];
    const userAlreadyDisabled = userArgs.includes("--no-sandbox");
    // A caller can request the sandbox AND still pass --no-sandbox in args; the
    // userArgs spread re-adds it last, so Chromium ends up unsandboxed despite the
    // request. Warn rather than silently dropping the sandbox.
    if (useSandbox && userAlreadyDisabled) {
      log.warn("launch_chrome: sandbox requested but --no-sandbox is in args; the flag wins and the sandbox stays OFF");
    }
    // Snap-confinement auto-profile. When the effective Chrome path (explicit
    // chromePath, or CHROME_PATH env that chrome-launcher will pick up) is
    // under /snap/ AND the caller didn't already specify userDataDir, derive
    // the snap-confined profile path so chrome-launcher doesn't hand snap-
    // Chromium a /tmp/... profile that snap confinement rejects (debug port
    // never opens; chrome-launcher's startup-port poll ECONNREFUSEs). Mirrors
    // the L3 globalSetup logic in test/e2e/setup/global.ts so the L4 eval
    // harness (which steers chrome-launcher via CHROME_PATH) and direct
    // launch_chrome callers inherit the same workaround without making the
    // agent responsible for it. (Codex review on PR #24.)
    const effectiveChromePath = opts.chromePath ?? process.env.CHROME_PATH;
    const autoUserDataDir =
      !opts.userDataDir && effectiveChromePath?.startsWith("/snap/")
        ? snapUserDataDir(effectiveChromePath)
        : undefined;
    if (autoUserDataDir) {
      mkdirSync(autoUserDataDir, { recursive: true });
    }
    const launchOpts: LaunchOptions = {
      startingUrl: opts.url ?? "about:blank",
      chromeFlags: [
        ...(opts.headless ? ["--headless=new"] : []),
        ...(!useSandbox && !userAlreadyDisabled ? ["--no-sandbox"] : []),
        ...userArgs,
      ],
      ...(opts.userDataDir
        ? { userDataDir: opts.userDataDir }
        : autoUserDataDir
          ? { userDataDir: autoUserDataDir }
          : {}),
      ...(opts.chromePath ? { chromePath: opts.chromePath } : {}),
    };
    const chrome = await launch(launchOpts);
    s.ownedProcess = { kind: "chrome", handle: chrome };
    s.chromePort = chrome.port;
    s.chromeHost = "127.0.0.1"; // chrome-launcher always binds localhost
    log.info("launched chrome", { port: chrome.port, pid: chrome.pid, sandbox: useSandbox });

    // Pick the first page target.
    const targets = await waitForFirstPage(chrome.port);
    const target = targets[0]!;
    await connectToTarget(s, chrome.port, target.id);
    s.url = target.url || null;
    registry.activate(rec.id);
    return { session: rec.id, label: rec.label ?? null, targetId: target.id, url: target.url };
  } catch (e) {
    await registry.abort(rec);
    throw e;
  }
}

export async function attachChrome(opts: AttachArgs = {}): Promise<{
  session: string;
  label: string | null;
  targetId: string;
  url: string;
}> {
  const rec = registry.reserve("browser", opts.label);
  const s = rec.state;
  try {
    const port = opts.port ?? DEFAULT_PORT;
    s.chromePort = port;
    s.chromeHost = opts.host ?? "127.0.0.1";
    s.attached = true;

    const targets = await CDP.List({ port, host: opts.host });
    const wantType = opts.targetFilter?.type;
    const wantUrl = opts.targetFilter?.urlIncludes;
    const filtered = targets.filter((t) => {
      // When a type filter is supplied, it is authoritative. Otherwise default
      // to "page" targets (the common debugging case).
      if (wantType) {
        if (t.type !== wantType) return false;
      } else if (t.type !== "page") {
        return false;
      }
      if (wantUrl && !t.url.includes(wantUrl)) return false;
      return true;
    });
    if (filtered.length === 0) {
      throw new Error(
        `No matching targets on the running Chrome (filter type=${wantType ?? "page"}, urlIncludes=${wantUrl ?? "*"})`,
      );
    }
    const target = filtered[0]!;
    await connectToTarget(s, port, target.id, opts.host);
    s.url = target.url || null;
    log.info("attached to chrome", { port, targetId: target.id, url: target.url });
    registry.activate(rec.id);
    return { session: rec.id, label: rec.label ?? null, targetId: target.id, url: target.url };
  } catch (e) {
    await registry.abort(rec);
    throw e;
  }
}

async function waitForFirstPage(port: number): Promise<Awaited<ReturnType<typeof CDP.List>>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const list = await CDP.List({ port });
      const pages = list.filter((t) => t.type === "page");
      if (pages.length > 0) return pages;
    } catch {
      // Chrome may not be ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome did not expose any page targets within 5s");
}

async function connectToTarget(s: Session, port: number, targetId: string, host?: string) {
  const client = await CDP({ port, host, target: targetId });
  s.client = client;
  s.currentTargetId = targetId;

  // Wire Target.attachedToTarget BEFORE setAutoAttach — Chrome immediately
  // enumerates pre-existing eligible children (workers, OOPIFs, service
  // workers) inline with the setAutoAttach response. If the listener is
  // registered after, those attachedToTarget events are dropped.
  try {
    await connectDebugger(s, client, undefined);
    await enableBrowserDomains(s, client, undefined);
    // Usually empty on first connect. select_target preserves logical script
    // definitions, clears their old installation ids, and reaches this path
    // to establish them on the replacement root before auto-attach begins.
    await replayPreDocumentScripts(s, client, undefined, false);
  } catch (e) {
    // Required Runtime/Debugger enable failed: tear down so a follow-up
    // launch/attach isn't blocked by already_session against a broken
    // session. (Ultrareview round 2 — Codex Medium #1, symmetric with
    // attach_node's post-init guard.) Registry-world note: this close()
    // releases the socket/process state only — freeing the SLOT is the
    // caller's registry rollback (launch/attach abort(), switchTarget's
    // failure-path closeState()).
    log.warn("connectToTarget init failed; tearing down", { error: String(e) });
    await s.close();
    throw e;
  }
  const onAttached = (params: Protocol.Target.AttachedToTargetEvent) => {
    void onChildAttached(s, client, params);
  };
  const onDetached = (params: Protocol.Target.DetachedFromTargetEvent) => {
    detachSession(s, client, params.sessionId);
  };
  client.on("Target.attachedToTarget", onAttached);
  client.on("Target.detachedFromTarget", onDetached);
  client.on("disconnect", () => log.warn("CDP disconnect"));
  try {
    await client.Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (e) {
    log.warn("Target.setAutoAttach failed", { error: String(e) });
  }
}

async function onChildAttached(
  s: Session,
  client: import("chrome-remote-interface").Client,
  params: Protocol.Target.AttachedToTargetEvent,
) {
  const sessionId = params.sessionId;
  log.debug("child target attached", { sessionId, type: params.targetInfo.type, url: params.targetInfo.url });
  try {
    await connectDebugger(s, client, sessionId);
    await enableBrowserDomains(s, client, sessionId);
    // Replay before recursively enabling auto-attach so this child is ready
    // before any nested child enumeration can arrive inline with that call.
    await replayPreDocumentScripts(s, client, sessionId, true);
    await client.Target.setAutoAttach(
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    // Inherit pause-on-exceptions setting so child sessions honor it from
    // birth, not only if the user re-issues the tool after they attach.
    if (s.pauseOnExceptions !== "none") {
      try {
        await client.Debugger.setPauseOnExceptions({ state: s.pauseOnExceptions }, sessionId);
      } catch (e) {
        log.warn("failed to apply pauseOnExceptions to child", { sessionId, error: String(e) });
      }
    }
  } catch (e) {
    log.warn("failed to enable child target", { sessionId, error: String(e) });
  }
}

function detachSession(
  s: Session,
  client: import("chrome-remote-interface").Client,
  sessionId: string,
) {
  log.debug("child target detached", { sessionId });
  // Remove every event handler we registered for this sub-session and drop
  // its scripts from the store — those scriptIds are now invalid.
  const handlers = s.sessionHandlers.get(sessionId);
  if (handlers) {
    for (const { event, handler } of handlers) {
      (client as unknown as { removeListener: (e: string, h: Function) => void }).removeListener(event, handler);
    }
    s.sessionHandlers.delete(sessionId);
  }
  // Drop scripts owned by this session so stale scriptIds don't survive.
  for (const sc of s.scripts.all()) {
    if (sc.sessionId === sessionId) s.scripts.remove(sc.scriptId, sc.sessionId);
  }
  for (const record of s.preDocumentScripts.values()) {
    record.installations.delete(sessionId);
  }
}

// Browser-only domain enable + Network ring-buffer wiring. The Runtime +
// Debugger half (target-agnostic) lives in src/session/debugger.ts and is
// invoked separately from connectToTarget so Node sessions can reuse it.
// (See the session-kind design notes.)
async function enableBrowserDomains(
  s: Session,
  client: import("chrome-remote-interface").Client,
  sessionId: string | undefined,
): Promise<void> {
  const own = (eventSessionId: string | undefined) => eventSessionId === sessionId;

  // Predicate that matches an entry by (requestId, sessionId). CDP requestIds
  // are scoped per Network agent — two iframes can both emit requestId="123" —
  // so the predicate must include sessionId to avoid cross-session collisions
  // in RingBuffer.update.
  const matchEntry = (requestId: string) => (e: { requestId: string; sessionId?: string }) =>
    e.requestId === requestId && e.sessionId === sessionId;

  registerHandler(s, client, sessionId, "Network.requestWillBeSent", (
    params: Protocol.Network.RequestWillBeSentEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    s.network.push({
      requestId: params.requestId,
      ts: Date.now(),
      url: params.request.url,
      method: params.request.method,
      resourceType: params.type,
      ...(sessionId ? { sessionId } : {}),
    });
  });

  registerHandler(s, client, sessionId, "Network.responseReceived", (
    params: Protocol.Network.ResponseReceivedEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    s.network.update(matchEntry(params.requestId), {
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      fromCache: params.response.fromDiskCache || params.response.fromPrefetchCache,
    });
  });

  registerHandler(s, client, sessionId, "Network.loadingFinished", (
    params: Protocol.Network.LoadingFinishedEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    // Use the entry's own ts (set at requestWillBeSent) to compute duration.
    const existing = s.network.query({ filter: matchEntry(params.requestId), limit: 1 }).pop();
    s.network.update(matchEntry(params.requestId), {
      ...(existing ? { durationMs: Date.now() - existing.ts } : {}),
      finished: true,
    });
  });

  registerHandler(s, client, sessionId, "Network.loadingFailed", (
    params: Protocol.Network.LoadingFailedEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    // Symmetric with onLoadingFinished: time-to-failure (DNS error, connect
    // refused, RST, abort, …) is useful for latency/anomaly analysis. Without
    // this, duration_ms is `number | undefined` purely as a function of
    // success vs. failure in the same call to get_network_requests.
    const existing = s.network.query({ filter: matchEntry(params.requestId), limit: 1 }).pop();
    s.network.update(matchEntry(params.requestId), {
      ...(existing ? { durationMs: Date.now() - existing.ts } : {}),
      failureReason: params.errorText,
      finished: true,
    });
  });

  const swallow = (p: Promise<unknown>) => p.then(() => {}, () => {});
  await swallow(client.Page.enable(sessionId));
  await swallow(client.DOM.enable({}, sessionId));
  await swallow(client.Network.enable({}, sessionId));
}

// Switch to a different target on the same browser without tearing down the
// chrome process. Used by select_target. The registry record stays "active"
// throughout — the accessors' client-null sentinel is what makes the
// mid-switch window read as "no session", exactly as it did pre-registry.
export async function switchTarget(s: Session, targetId: string): Promise<{ targetId: string; url: string }> {
  if (!s.client) throw new Error("No active session");
  const port = s.chromePort!;
  const host = s.chromeHost ?? undefined;
  const attached = s.attached;
  const ownedProcess = s.ownedProcess;
  try {
    await s.client.close().catch(() => {});
  } catch {
    /* ignore */
  }
  s.client = null;
  s.currentTargetId = null;
  s.pause.reset();
  s.scripts.clear();
  s.breakpoints.clear();
  s.sessionHandlers.clear();
  // Keep the logical definitions across select_target, just as
  // pauseOnExceptions survives; only their old per-CDP-session identifiers
  // are invalid after the socket closes. connectToTarget replays the root and
  // onChildAttached fills child installations as they are enumerated.
  for (const record of s.preDocumentScripts.values()) {
    record.installations.clear();
  }
  s.chromePort = port;
  s.chromeHost = host ?? null;
  s.attached = attached;
  s.ownedProcess = ownedProcess;
  try {
    await connectToTarget(s, port, targetId, host);
  } catch (e) {
    // A failed reconnect leaves the record ACTIVE but clientless — the one
    // state the accessors read as "no session" while reserve() still counts
    // it (round-1 P1: close_session couldn't reach the record, every
    // launch/attach hit already_session, and only a server restart
    // recovered). closeState(s) tears down EXACTLY this record — not the
    // id-less close(), which per-kind capacity now lets pick a concurrent
    // other-kind record (review round 1). Deliberate delta vs the singleton
    // world: an OWNED Chrome is now killed here rather than orphaned.
    try {
      await registry.closeState(s);
    } catch {
      /* the reconnect error is the one worth surfacing */
    }
    throw e;
  }
  const list = await CDP.List({ port, host });
  const t = list.find((x) => x.id === targetId);
  s.url = t?.url || null; // null = unknown (|| so an empty "" also normalizes); string form kept only in the tool return
  return { targetId, url: t?.url ?? "" };
}
