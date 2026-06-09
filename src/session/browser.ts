import { mkdirSync } from "node:fs";
import CDP from "chrome-remote-interface";
import { launch, type LaunchedChrome, type Options as LaunchOptions } from "chrome-launcher";
import type { Protocol } from "devtools-protocol";
import { sessionState, ROOT_SESSION_KEY, type Session, type HandlerEntry } from "./state.js";
import { attachScriptListener } from "../sourcemap/loader.js";
import { mapCdpToOriginal } from "../sourcemap/store.js";
import { alreadySession } from "../util/errors.js";
import { previewRemoteObject } from "../util/format.js";
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
}

export interface AttachArgs {
  port?: number;
  host?: string;
  targetFilter?: { type?: string; urlIncludes?: string };
}

const DEFAULT_PORT = 9222;

export async function launchChrome(opts: LaunchArgs = {}): Promise<{
  targetId: string;
  url: string;
}> {
  if (sessionState.client) throw alreadySession();
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
  sessionState.chrome = chrome;
  sessionState.chromePort = chrome.port;
  log.info("launched chrome", { port: chrome.port, pid: chrome.pid, sandbox: useSandbox });

  // Pick the first page target.
  const targets = await waitForFirstPage(chrome.port);
  const target = targets[0]!;
  await connectToTarget(chrome.port, target.id);
  return { targetId: target.id, url: target.url };
}

export async function attachChrome(opts: AttachArgs = {}): Promise<{
  targetId: string;
  url: string;
}> {
  if (sessionState.client) throw alreadySession();
  const port = opts.port ?? DEFAULT_PORT;
  sessionState.chromePort = port;
  sessionState.attached = true;

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
  await connectToTarget(port, target.id, opts.host);
  log.info("attached to chrome", { port, targetId: target.id, url: target.url });
  return { targetId: target.id, url: target.url };
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

async function connectToTarget(port: number, targetId: string, host?: string) {
  const client = await CDP({ port, host, target: targetId });
  sessionState.client = client;
  sessionState.currentTargetId = targetId;

  // Wire root-target handlers and Target.attachedToTarget BEFORE setAutoAttach
  // — Chrome immediately enumerates pre-existing eligible children (workers,
  // OOPIFs, service workers) inline with the setAutoAttach response. If the
  // listener is registered after, those attachedToTarget events are dropped.
  wireDomainHandlers(client, undefined);
  const onAttached = (params: Protocol.Target.AttachedToTargetEvent) => {
    void onChildAttached(client, params);
  };
  const onDetached = (params: Protocol.Target.DetachedFromTargetEvent) => {
    detachSession(client, params.sessionId);
  };
  client.on("Target.attachedToTarget", onAttached);
  client.on("Target.detachedFromTarget", onDetached);
  client.on("disconnect", () => log.warn("CDP disconnect"));

  await enableDomains(client, undefined);
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
  client: import("chrome-remote-interface").Client,
  params: Protocol.Target.AttachedToTargetEvent,
) {
  const sessionId = params.sessionId;
  log.debug("child target attached", { sessionId, type: params.targetInfo.type, url: params.targetInfo.url });
  try {
    wireDomainHandlers(client, sessionId);
    await enableDomains(client, sessionId);
    await client.Target.setAutoAttach(
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    // Inherit pause-on-exceptions setting so child sessions honor it from
    // birth, not only if the user re-issues the tool after they attach.
    if (sessionState.pauseOnExceptions !== "none") {
      try {
        await client.Debugger.setPauseOnExceptions({ state: sessionState.pauseOnExceptions }, sessionId);
      } catch (e) {
        log.warn("failed to apply pauseOnExceptions to child", { sessionId, error: String(e) });
      }
    }
  } catch (e) {
    log.warn("failed to enable child target", { sessionId, error: String(e) });
  }
}

function detachSession(
  client: import("chrome-remote-interface").Client,
  sessionId: string,
) {
  log.debug("child target detached", { sessionId });
  // Remove every event handler we registered for this sub-session and drop
  // its scripts from the store — those scriptIds are now invalid.
  const handlers = sessionState.sessionHandlers.get(sessionId);
  if (handlers) {
    for (const { event, handler } of handlers) {
      (client as unknown as { removeListener: (e: string, h: Function) => void }).removeListener(event, handler);
    }
    sessionState.sessionHandlers.delete(sessionId);
  }
  // Drop scripts owned by this session so stale scriptIds don't survive.
  for (const sc of sessionState.scripts.all()) {
    if (sc.sessionId === sessionId) sessionState.scripts.remove(sc.scriptId, sc.sessionId);
  }
}

async function enableDomains(
  client: import("chrome-remote-interface").Client,
  sessionId: string | undefined,
) {
  // The full debugger surface needs these. Some are no-ops on workers but harmless.
  const swallow = (p: Promise<unknown>) => p.then(() => {}, () => {});
  await swallow(client.Runtime.enable(sessionId));
  await swallow(client.Debugger.enable({}, sessionId));
  await swallow(client.Page.enable(sessionId));
  await swallow(client.DOM.enable({}, sessionId));
  await swallow(client.Network.enable({}, sessionId));
}

function wireDomainHandlers(
  client: import("chrome-remote-interface").Client,
  sessionId: string | undefined,
): void {
  // The strict gate: only process events from THIS session. The original
  // implementation used `if (sessionId && eventSessionId !== sessionId)`,
  // which is vacuously false when sessionId is undefined (the root) —
  // making the root handler process every child session's events too.
  const own = (eventSessionId: string | undefined) => eventSessionId === sessionId;
  const registered: HandlerEntry[] = [];
  const reg = (event: string, handler: (...args: any[]) => void) => {
    client.on(event as any, handler as any);
    registered.push({ event, handler });
  };

  // Source-map / Debugger.scriptParsed
  const scriptHandler = attachScriptListener(client, sessionState.scripts, sessionId);
  registered.push({ event: "Debugger.scriptParsed", handler: scriptHandler });

  const onPaused = (params: Protocol.Debugger.PausedEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    sessionState.pause.onPaused({
      reason: params.reason,
      data: params.data,
      hitBreakpoints: params.hitBreakpoints,
      callFrames: params.callFrames,
      asyncStackTrace: params.asyncStackTrace,
      sessionId: eventSessionId,
      pausedAt: Date.now(),
    });
    log.debug("paused", { reason: params.reason, hit: params.hitBreakpoints });
  };
  reg("Debugger.paused", onPaused);

  const onResumed = (_p: unknown, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    sessionState.pause.onResumed();
  };
  reg("Debugger.resumed", onResumed);

  const onConsoleApi = (params: Protocol.Runtime.ConsoleAPICalledEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    pushConsoleFromApi(sessionState, params, eventSessionId);
  };
  reg("Runtime.consoleAPICalled", onConsoleApi);

  const onException = (params: Protocol.Runtime.ExceptionThrownEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    pushConsoleFromException(sessionState, params, eventSessionId);
  };
  reg("Runtime.exceptionThrown", onException);

  // Predicate that matches an entry by (requestId, sessionId). CDP requestIds
  // are scoped per Network agent — two iframes can both emit requestId="123" —
  // so the predicate must include sessionId to avoid cross-session collisions
  // in RingBuffer.update.
  const matchEntry = (requestId: string) => (e: { requestId: string; sessionId?: string }) =>
    e.requestId === requestId && e.sessionId === sessionId;

  const onRequest = (params: Protocol.Network.RequestWillBeSentEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    sessionState.network.push({
      requestId: params.requestId,
      ts: Date.now(),
      url: params.request.url,
      method: params.request.method,
      resourceType: params.type,
      ...(sessionId ? { sessionId } : {}),
    });
  };
  reg("Network.requestWillBeSent", onRequest);

  const onResponse = (params: Protocol.Network.ResponseReceivedEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    sessionState.network.update(matchEntry(params.requestId), {
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      fromCache: params.response.fromDiskCache || params.response.fromPrefetchCache,
    });
  };
  reg("Network.responseReceived", onResponse);

  const onLoadingFinished = (params: Protocol.Network.LoadingFinishedEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    // Use the entry's own ts (set at requestWillBeSent) to compute duration.
    const existing = sessionState.network.query({ filter: matchEntry(params.requestId), limit: 1 }).pop();
    sessionState.network.update(matchEntry(params.requestId), {
      ...(existing ? { durationMs: Date.now() - existing.ts } : {}),
      finished: true,
    });
  };
  reg("Network.loadingFinished", onLoadingFinished);

  const onLoadingFailed = (params: Protocol.Network.LoadingFailedEvent, eventSessionId?: string) => {
    if (!own(eventSessionId)) return;
    // Symmetric with onLoadingFinished: time-to-failure (DNS error, connect
    // refused, RST, abort, …) is useful for latency/anomaly analysis. Without
    // this, duration_ms is `number | undefined` purely as a function of
    // success vs. failure in the same call to get_network_requests.
    const existing = sessionState.network.query({ filter: matchEntry(params.requestId), limit: 1 }).pop();
    sessionState.network.update(matchEntry(params.requestId), {
      ...(existing ? { durationMs: Date.now() - existing.ts } : {}),
      failureReason: params.errorText,
      finished: true,
    });
  };
  reg("Network.loadingFailed", onLoadingFailed);

  sessionState.sessionHandlers.set(sessionId ?? ROOT_SESSION_KEY, registered);
}

function pushConsoleFromApi(s: Session, params: Protocol.Runtime.ConsoleAPICalledEvent, sessionId: string | undefined) {
  // Two formatting modes:
  //   - String args render as raw text (no surrounding quotes, no \n→\\n
  //     escapes) — matches how DevTools / Node / every log shipper renders
  //     console.log("Server started"). previewRemoteObject would
  //     JSON.stringify them, which is right for REPL/evaluate output but
  //     wrong for console buffering.
  //   - Everything else (numbers, objects, arrays, functions, …) goes
  //     through previewRemoteObject so {foo:1} keeps its shape.
  const renderArg = (a: Protocol.Runtime.RemoteObject) =>
    a.type === "string" ? (a.value ?? "") : previewRemoteObject(a);
  const text =
    params.args.length === 0
      ? "(no args)"
      : params.args.map(renderArg).join(" ");
  const top = params.stackTrace?.callFrames?.[0];
  const mapped = top ? mapCdpToOriginal(s.scripts, {
    scriptId: top.scriptId,
    lineNumber: top.lineNumber,
    columnNumber: top.columnNumber,
  }, sessionId) : null;
  s.console.push({
    ts: Date.now(),
    level: mapApiLevel(params.type),
    text,
    source: "console-api",
    ...(top?.url ? { url: top.url } : {}),
    ...(top ? { lineNumber: top.lineNumber, columnNumber: top.columnNumber } : {}),
    ...(mapped ? { mappedFile: mapped.file, mappedLine: mapped.line, mappedColumn: mapped.column } : {}),
    ...(params.stackTrace ? { stack: params.stackTrace } : {}),
  });
}

function pushConsoleFromException(s: Session, params: Protocol.Runtime.ExceptionThrownEvent, sessionId: string | undefined) {
  const det = params.exceptionDetails;
  const top = det.stackTrace?.callFrames?.[0];
  const mapped = top ? mapCdpToOriginal(s.scripts, {
    scriptId: top.scriptId,
    lineNumber: top.lineNumber,
    columnNumber: top.columnNumber,
  }, sessionId) : null;
  const text =
    (det.exception?.description ?? det.exception?.value ?? det.text) + "";
  s.console.push({
    ts: Date.now(),
    level: "error",
    text,
    source: "runtime-exception",
    ...(top?.url ? { url: top.url } : { url: det.url }),
    ...(top ? { lineNumber: top.lineNumber, columnNumber: top.columnNumber } : { lineNumber: det.lineNumber, columnNumber: det.columnNumber }),
    ...(mapped ? { mappedFile: mapped.file, mappedLine: mapped.line, mappedColumn: mapped.column } : {}),
    ...(det.stackTrace ? { stack: det.stackTrace } : {}),
  });
}

function mapApiLevel(t: Protocol.Runtime.ConsoleAPICalledEvent["type"]): import("./buffers.js").ConsoleEntry["level"] {
  switch (t) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "trace":
      return "trace";
    case "log":
    default:
      return "log";
  }
}

export async function closeSession(): Promise<void> {
  await sessionState.close();
}

// Switch to a different target on the same browser without tearing down the
// chrome process. Used by select_target.
export async function switchTarget(targetId: string): Promise<{ targetId: string; url: string }> {
  if (!sessionState.client) throw new Error("No active session");
  const port = sessionState.chromePort!;
  const attached = sessionState.attached;
  const chrome = sessionState.chrome;
  try {
    await sessionState.client.close().catch(() => {});
  } catch {
    /* ignore */
  }
  sessionState.client = null;
  sessionState.currentTargetId = null;
  sessionState.pause.reset();
  sessionState.scripts.clear();
  sessionState.breakpoints.clear();
  sessionState.sessionHandlers.clear();
  sessionState.chromePort = port;
  sessionState.attached = attached;
  sessionState.chrome = chrome;
  await connectToTarget(port, targetId);
  const list = await CDP.List({ port });
  const t = list.find((x) => x.id === targetId);
  return { targetId, url: t?.url ?? "" };
}
