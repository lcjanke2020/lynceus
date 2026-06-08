// Fake CDP client for L2 tool-contract tests.
//
// The linchpin file. Tests assign `sessionState.client = makeFakeCdp() as
// unknown as CDP.Client` and drive the same handler entry points that the
// production MCP server registers. Quality of the L2 layer hinges on this
// fake faithfully mirroring three real-Chrome contracts:
//
// 1. flatten:true session events — events arrive on the root socket with
//    `eventSessionId` as a SECOND emit argument. The production guard at
//    src/session/browser.ts:206 reads `eventSessionId === sessionId`; a
//    one-arg fake silently bypasses that guard and worker tests pass when
//    they should fail.
// 2. Auto-attach replay — Chrome's Target.setAutoAttach response
//    enumerates pre-existing children INLINE with the response, so any
//    handler registered AFTER the await sees nothing. The fake's onSend()
//    hook fires synchronously before send() resolves so tests can
//    reproduce this exactly.
// 3. Network lifecycle ordering — RingBuffer.update relies on
//    requestWillBeSent firing before responseReceived which fires before
//    loadingFinished. The fireNetworkLifecycle() macro chains them in
//    that order with the right field shapes; without it every per-tool
//    test re-encodes the lifecycle and tests diverge on field names.

import { EventEmitter } from "node:events";
import type { Protocol } from "devtools-protocol";
import type { PauseState } from "../src/session/pause.js";

// ---------------------------------------------------------------------------
// Public types

export type SendHandler = (
  params: any,
  sessionId?: string,
) => unknown | Promise<unknown>;

export type SendHook = (params: any, sessionId?: string) => void;

export interface SentCall {
  method: string;
  params: any;
  sessionId?: string;
}

export interface SeedScriptOpts {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  sessionId?: string;
  executionContextId?: number;
  hash?: string;
  isModule?: boolean;
  startLine?: number;
  endLine?: number;
}

export interface FireNetworkOpts {
  url?: string;
  method?: string;
  type?: string; // resource type: Document, XHR, Fetch, ...
  sessionId?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  // Lifecycle outcome — exactly one of these:
  finished?: boolean; // default true
  failed?: boolean;
  errorText?: string;
}

export interface MakePauseStateOpts {
  reason?: Protocol.Debugger.PausedEvent["reason"];
  hitBreakpoints?: string[];
  sessionId?: string;
  callFrames?: Protocol.Debugger.CallFrame[];
  data?: object;
}

export interface FakeCdp extends EventEmitter {
  // Surface that mirrors `chrome-remote-interface`'s Client. Tests cast
  // `as unknown as CDP.Client` when assigning to sessionState.client.
  send(method: string, params?: any, sessionId?: string): Promise<any>;
  close(): Promise<void>;

  // Domain shorthands. Each delegates to send() so tests can override via
  // respond() and the production wireDomainHandlers code paths run
  // unchanged. Call signatures match what production actually invokes
  // (some methods take only sessionId; others take params first).
  Runtime: {
    enable(sessionId?: string): Promise<void>;
    evaluate(params: any, sessionId?: string): Promise<any>;
    getProperties(params: any, sessionId?: string): Promise<any>;
  };
  Debugger: {
    enable(params: any, sessionId?: string): Promise<any>;
    setBreakpointByUrl(params: any, sessionId?: string): Promise<any>;
    removeBreakpoint(params: any, sessionId?: string): Promise<any>;
    setPauseOnExceptions(params: any, sessionId?: string): Promise<any>;
    resume(params: any, sessionId?: string): Promise<any>;
    pause(params: any, sessionId?: string): Promise<any>;
    stepOver(params: any, sessionId?: string): Promise<any>;
    stepInto(params: any, sessionId?: string): Promise<any>;
    stepOut(params: any, sessionId?: string): Promise<any>;
    getScriptSource(params: any, sessionId?: string): Promise<any>;
    evaluateOnCallFrame(params: any, sessionId?: string): Promise<any>;
  };
  Page: {
    enable(sessionId?: string): Promise<void>;
    getFrameTree(sessionId?: string): Promise<any>;
    navigate(params: any, sessionId?: string): Promise<any>;
    reload(params: any, sessionId?: string): Promise<any>;
    captureScreenshot(params: any, sessionId?: string): Promise<any>;
  };
  DOM: {
    enable(params: any, sessionId?: string): Promise<void>;
    getDocument(params: any, sessionId?: string): Promise<any>;
    querySelector(params: any, sessionId?: string): Promise<any>;
    describeNode(params: any, sessionId?: string): Promise<any>;
    getOuterHTML(params: any, sessionId?: string): Promise<any>;
  };
  Network: {
    enable(params: any, sessionId?: string): Promise<void>;
    getRequestPostData(params: any, sessionId?: string): Promise<any>;
    getResponseBody(params: any, sessionId?: string): Promise<any>;
    loadNetworkResource(params: any, sessionId?: string): Promise<any>;
  };
  Target: {
    setAutoAttach(params: any, sessionId?: string): Promise<void>;
  };
  IO: {
    read(params: any, sessionId?: string): Promise<any>;
    close(params: any, sessionId?: string): Promise<any>;
  };
  Input: {
    dispatchMouseEvent(params: any, sessionId?: string): Promise<void>;
    dispatchKeyEvent(params: any, sessionId?: string): Promise<void>;
    insertText(params: any, sessionId?: string): Promise<void>;
  };

  // Test-side helpers
  /** Override the default response for a method. */
  respond(method: string, fn: SendHandler): void;
  /** Register a synchronous side-effect that fires BEFORE send() resolves. */
  onSend(method: string, hook: SendHook): void;
  /** Emit an event with the flatten:true two-arg shape. */
  fireEvent(event: string, params: any, sessionId?: string): void;
  /** Seed a Debugger.scriptParsed event into the registered listener. */
  seedScript(opts: SeedScriptOpts): void;
  /** Chain Network.requestWillBeSent → responseReceived → loadingFinished/Failed. */
  fireNetworkLifecycle(requestId: string, opts?: FireNetworkOpts): void;
  /** Build a PauseState compatible with PauseTracker.onPaused. */
  makePauseState(opts?: MakePauseStateOpts): PauseState;
  /** Read-only log of every send() call in arrival order. */
  readonly sentCalls: ReadonlyArray<SentCall>;
  /** Reset sentCalls (useful between arrange/act phases of a single test). */
  clearSentCalls(): void;
}

// ---------------------------------------------------------------------------
// Implementation

export function makeFakeCdp(): FakeCdp {
  const emitter = new EventEmitter();
  // Allow many listeners — production registers one per session-handler
  // for several events; with 5+ child sessions we'd hit the default cap of 10.
  emitter.setMaxListeners(0);

  const responders = new Map<string, SendHandler>();
  const hooks = new Map<string, SendHook[]>();
  const sentCalls: SentCall[] = [];
  let pauseStateSeed = 0;

  // Sensible defaults so tests don't have to register a responder for every
  // method production calls during enableDomains/wireDomainHandlers.
  responders.set("Runtime.enable", () => undefined);
  responders.set("Debugger.enable", () => ({ debuggerId: "fake-debugger" }));
  responders.set("Page.enable", () => undefined);
  responders.set("DOM.enable", () => undefined);
  responders.set("Network.enable", () => undefined);
  responders.set("Target.setAutoAttach", () => undefined);
  responders.set("Debugger.setPauseOnExceptions", () => undefined);
  responders.set("Debugger.resume", () => undefined);
  responders.set("Debugger.pause", () => undefined);
  responders.set("Debugger.stepOver", () => undefined);
  responders.set("Debugger.stepInto", () => undefined);
  responders.set("Debugger.stepOut", () => undefined);
  responders.set("Debugger.removeBreakpoint", () => undefined);
  responders.set("Debugger.setBreakpointByUrl", (params: any) => ({
    // Default: derive a deterministic breakpointId so tests can predict it.
    breakpointId: `bp:${params.url}:${params.lineNumber}:${params.columnNumber ?? 0}`,
    locations: [
      {
        scriptId: "fake-script-id",
        lineNumber: params.lineNumber,
        columnNumber: params.columnNumber ?? 0,
      },
    ],
  }));
  responders.set("Page.getFrameTree", () => ({
    frameTree: {
      frame: { id: "fake-frame", url: "about:blank", domainAndRegistry: "" },
      childFrames: [],
    },
  }));
  responders.set("Page.navigate", () => ({ frameId: "fake-frame", loaderId: "fake-loader" }));
  responders.set("Page.reload", () => undefined);
  // 1x1 transparent PNG. The L2 screenshot test verifies that production
  // emits a base64 PNG; using a real header-prefixed payload here lets
  // tests assert "starts with iVBOR" without rebuilding the whole pipeline.
  responders.set("Page.captureScreenshot", () => ({
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  }));
  responders.set("Runtime.evaluate", () => ({ result: { type: "undefined" } }));
  responders.set("Runtime.callFunctionOn", () => ({ result: { type: "undefined" } }));
  responders.set("Runtime.getProperties", () => ({ result: [] }));
  responders.set("Debugger.evaluateOnCallFrame", () => ({ result: { type: "undefined" } }));
  responders.set("Debugger.getScriptSource", () => ({ scriptSource: "" }));
  responders.set("DOM.getDocument", () => ({ root: { nodeId: 1, nodeName: "#document" } }));
  // nodeId 0 = "not found" by CDP convention. Tests override with respond()
  // when they want to simulate a found element.
  responders.set("DOM.querySelector", () => ({ nodeId: 0 }));
  responders.set("DOM.describeNode", () => ({
    node: { nodeId: 0, nodeName: "DIV", attributes: [], backendNodeId: 0 },
  }));
  responders.set("DOM.getOuterHTML", () => ({ outerHTML: "<div></div>" }));
  responders.set("DOM.resolveNode", () => ({ object: { objectId: "fake-object-id" } }));
  responders.set("Network.getRequestPostData", () => ({ postData: "" }));
  responders.set("Network.getResponseBody", () => ({ body: "", base64Encoded: false }));
  responders.set("Network.getAllCookies", () => ({ cookies: [] }));
  responders.set("Network.getCookies", () => ({ cookies: [] }));
  responders.set("Network.setCookies", () => undefined);
  responders.set("Input.dispatchMouseEvent", () => undefined);
  responders.set("Input.dispatchKeyEvent", () => undefined);
  responders.set("Input.insertText", () => undefined);

  // Methods that legitimately have no payload — production calls them and
  // discards the response (Runtime.enable etc.). Listed here explicitly so
  // an unmodeled NEW production call can't masquerade as a successful no-op.
  // To handle a method not in this set, register a responder via fake.respond().
  const KNOWN_VOID_METHODS = new Set<string>([
    "Runtime.enable",
    "Page.enable",
    "DOM.enable",
    "Network.enable",
    "Target.setAutoAttach",
    "Debugger.setPauseOnExceptions",
    "Debugger.resume",
    "Debugger.pause",
    "Debugger.stepOver",
    "Debugger.stepInto",
    "Debugger.stepOut",
    "Debugger.removeBreakpoint",
    "Page.enable",
    "Page.reload",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
  ]);

  const send = async (method: string, params?: any, sessionId?: string): Promise<any> => {
    sentCalls.push({ method, params, sessionId });
    // Hooks fire SYNCHRONOUSLY before the response promise is constructed,
    // so any events they emit reach production handlers BEFORE the awaiter
    // of send() resumes. This is the auto-attach replay invariant: Chrome's
    // setAutoAttach response carries inline attachedToTarget events.
    const hookFns = hooks.get(method);
    if (hookFns) {
      for (const h of hookFns) h(params, sessionId);
    }
    const fn = responders.get(method);
    if (fn) {
      const out = fn(params, sessionId);
      return out instanceof Promise ? out : out;
    }
    if (KNOWN_VOID_METHODS.has(method)) {
      // Legitimately no-op; allowlisted because production calls them
      // and ignores the response.
      return undefined;
    }
    // Fail-fast on truly unknown methods. Was previously a silent `{}`
    // fallback, but that hid typos in test setup and let new production
    // CDP calls masquerade as successful empty responses (Codex round-2
    // Med finding on PR #10).
    throw new Error(
      `Fake CDP: no responder registered for '${method}'. ` +
        `Use fake.respond('${method}', () => ...) or, if it's a true no-op, ` +
        `add it to KNOWN_VOID_METHODS in test/fake-cdp.ts.`,
    );
  };

  const fake: Partial<FakeCdp> = Object.assign(emitter, {
    send,
    async close() {
      // Reset listener-, hook-, and call-history state so the fake is
      // safely re-usable across test phases (Cursor PR #10 round-2 Low
      // finding: docstring claimed safe reuse but only listeners were
      // cleared, leaving hooks/sentCalls behavior to leak across phases).
      // Responders are NOT cleared — `fake.respond()` overrides are
      // intended to be sticky for tests that share a fake across multiple
      // acts; tests that want a fresh fake should construct a new one.
      emitter.removeAllListeners();
      hooks.clear();
      sentCalls.length = 0;
    },

    Runtime: {
      enable: (sessionId?: string) => send("Runtime.enable", undefined, sessionId),
      evaluate: (params: any, sessionId?: string) => send("Runtime.evaluate", params, sessionId),
      getProperties: (params: any, sessionId?: string) => send("Runtime.getProperties", params, sessionId),
    },
    Debugger: {
      enable: (params: any, sessionId?: string) => send("Debugger.enable", params, sessionId),
      setBreakpointByUrl: (params: any, sessionId?: string) => send("Debugger.setBreakpointByUrl", params, sessionId),
      removeBreakpoint: (params: any, sessionId?: string) => send("Debugger.removeBreakpoint", params, sessionId),
      setPauseOnExceptions: (params: any, sessionId?: string) => send("Debugger.setPauseOnExceptions", params, sessionId),
      resume: (params: any, sessionId?: string) => send("Debugger.resume", params, sessionId),
      pause: (params: any, sessionId?: string) => send("Debugger.pause", params, sessionId),
      stepOver: (params: any, sessionId?: string) => send("Debugger.stepOver", params, sessionId),
      stepInto: (params: any, sessionId?: string) => send("Debugger.stepInto", params, sessionId),
      stepOut: (params: any, sessionId?: string) => send("Debugger.stepOut", params, sessionId),
      getScriptSource: (params: any, sessionId?: string) => send("Debugger.getScriptSource", params, sessionId),
      evaluateOnCallFrame: (params: any, sessionId?: string) => send("Debugger.evaluateOnCallFrame", params, sessionId),
    },
    Page: {
      enable: (sessionId?: string) => send("Page.enable", undefined, sessionId),
      getFrameTree: (sessionId?: string) => send("Page.getFrameTree", undefined, sessionId),
      navigate: (params: any, sessionId?: string) => send("Page.navigate", params, sessionId),
      reload: (params: any, sessionId?: string) => send("Page.reload", params, sessionId),
      captureScreenshot: (params: any, sessionId?: string) => send("Page.captureScreenshot", params, sessionId),
    },
    DOM: {
      enable: (params: any, sessionId?: string) => send("DOM.enable", params, sessionId),
      getDocument: (params: any, sessionId?: string) => send("DOM.getDocument", params, sessionId),
      querySelector: (params: any, sessionId?: string) => send("DOM.querySelector", params, sessionId),
      describeNode: (params: any, sessionId?: string) => send("DOM.describeNode", params, sessionId),
      getOuterHTML: (params: any, sessionId?: string) => send("DOM.getOuterHTML", params, sessionId),
    },
    Network: {
      enable: (params: any, sessionId?: string) => send("Network.enable", params, sessionId),
      getRequestPostData: (params: any, sessionId?: string) => send("Network.getRequestPostData", params, sessionId),
      getResponseBody: (params: any, sessionId?: string) => send("Network.getResponseBody", params, sessionId),
      loadNetworkResource: (params: any, sessionId?: string) => send("Network.loadNetworkResource", params, sessionId),
    },
    Target: {
      setAutoAttach: (params: any, sessionId?: string) => send("Target.setAutoAttach", params, sessionId),
    },
    IO: {
      read: (params: any, sessionId?: string) => send("IO.read", params, sessionId),
      close: (params: any, sessionId?: string) => send("IO.close", params, sessionId),
    },
    Input: {
      dispatchMouseEvent: (params: any, sessionId?: string) => send("Input.dispatchMouseEvent", params, sessionId),
      dispatchKeyEvent: (params: any, sessionId?: string) => send("Input.dispatchKeyEvent", params, sessionId),
      insertText: (params: any, sessionId?: string) => send("Input.insertText", params, sessionId),
    },

    respond(method: string, fn: SendHandler) {
      responders.set(method, fn);
    },

    onSend(method: string, hook: SendHook) {
      const list = hooks.get(method) ?? [];
      list.push(hook);
      hooks.set(method, list);
    },

    fireEvent(event: string, params: any, sessionId?: string) {
      // flatten:true contract: session events arrive on the root socket
      // with eventSessionId as a SECOND emit argument. Always emit two
      // args so production handlers' eventSessionId === sessionId guard
      // is exercised correctly. For root events, sessionId is undefined.
      emitter.emit(event, params, sessionId);
    },

    seedScript(opts: SeedScriptOpts) {
      // Match the Protocol.Debugger.ScriptParsedEvent shape that
      // attachScriptListener (src/sourcemap/loader.ts:12) destructures.
      const params = {
        scriptId: opts.scriptId,
        url: opts.url,
        sourceMapURL: opts.sourceMapURL ?? "",
        startLine: opts.startLine ?? 0,
        startColumn: 0,
        endLine: opts.endLine ?? 100,
        endColumn: 0,
        executionContextId: opts.executionContextId ?? 1,
        hash: opts.hash ?? "fake-hash",
        isModule: opts.isModule ?? false,
      };
      emitter.emit("Debugger.scriptParsed", params, opts.sessionId);
    },

    fireNetworkLifecycle(requestId: string, opts: FireNetworkOpts = {}) {
      const sessionId = opts.sessionId;
      const url = opts.url ?? "http://localhost/example";
      // requestWillBeSent — production reads request.url, request.method, type.
      emitter.emit(
        "Network.requestWillBeSent",
        {
          requestId,
          loaderId: "fake-loader",
          documentURL: url,
          request: { url, method: opts.method ?? "GET", headers: {} },
          timestamp: 0,
          wallTime: 0,
          initiator: { type: "other" },
          type: opts.type ?? "Fetch",
        },
        sessionId,
      );
      if (opts.failed) {
        emitter.emit(
          "Network.loadingFailed",
          {
            requestId,
            timestamp: 0,
            type: opts.type ?? "Fetch",
            errorText: opts.errorText ?? "net::ERR_FAILED",
            canceled: false,
          },
          sessionId,
        );
        return;
      }
      // Default success path: responseReceived → loadingFinished.
      emitter.emit(
        "Network.responseReceived",
        {
          requestId,
          loaderId: "fake-loader",
          timestamp: 0,
          type: opts.type ?? "Fetch",
          response: {
            url,
            status: opts.status ?? 200,
            statusText: opts.statusText ?? "OK",
            headers: {},
            mimeType: opts.mimeType ?? "text/plain",
            connectionReused: false,
            connectionId: 0,
            encodedDataLength: 0,
            securityState: "secure",
            fromDiskCache: !!opts.fromCache,
            fromPrefetchCache: false,
          },
        },
        sessionId,
      );
      if (opts.finished !== false) {
        emitter.emit(
          "Network.loadingFinished",
          {
            requestId,
            timestamp: 0,
            encodedDataLength: 0,
          },
          sessionId,
        );
      }
    },

    makePauseState(opts: MakePauseStateOpts = {}): PauseState {
      // Counter-seed objectIds so back-to-back makePauseState() calls in the
      // same test produce non-colliding objectIds (Opus PR #10 round-2 Nit:
      // fixed objectIds were a future-trap for multi-pause tests).
      const seed = ++pauseStateSeed;
      const callFrames =
        opts.callFrames ??
        ([
          {
            callFrameId: `frame-${seed}-0`,
            functionName: "computeStep",
            functionLocation: { scriptId: "fake-script-id", lineNumber: 6, columnNumber: 0 },
            location: { scriptId: "fake-script-id", lineNumber: 6, columnNumber: 0 },
            url: "http://localhost/handlers.js",
            scopeChain: [
              {
                type: "local",
                object: {
                  type: "object",
                  className: "Object",
                  description: "Object",
                  objectId: `scope-local-${seed}`,
                },
              },
              {
                type: "global",
                object: {
                  type: "object",
                  className: "Window",
                  description: "Window",
                  objectId: `scope-global-${seed}`,
                },
              },
            ],
            this: {
              type: "object",
              className: "Window",
              description: "Window",
              objectId: `this-${seed}`,
            },
          },
        ] as unknown as Protocol.Debugger.CallFrame[]);
      return {
        reason: opts.reason ?? "breakpoint",
        ...(opts.data !== undefined ? { data: opts.data } : {}),
        ...(opts.hitBreakpoints ? { hitBreakpoints: opts.hitBreakpoints } : {}),
        callFrames,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        pausedAt: Date.now(),
      };
    },

    get sentCalls() {
      return sentCalls as ReadonlyArray<SentCall>;
    },

    clearSentCalls() {
      sentCalls.length = 0;
    },
  });

  return fake as FakeCdp;
}
