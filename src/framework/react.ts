import type { Protocol } from "devtools-protocol";
import type {
  FrameworkAdapter,
  FrameworkAttachResult,
  FrameworkDetachResult,
} from "./adapter.js";
import {
  addPreDocumentScript,
  installReactBridgeBindings,
  removePreDocumentScript,
  removeReactBridgeBindings,
} from "../session/browser.js";
import {
  registerHandler,
  unregisterHandler,
  type ReactBridgeState,
  type Session,
} from "../session/state.js";
import { ToolError } from "../util/errors.js";
import { log } from "../util/log.js";
import {
  getReactBackendSource,
  REACT_DEVTOOLS_CORE_VERSION,
} from "./react-backend.js";

export const REACT_BINDING_NAME = "__lynceusReact__" as const;
export const REACT_BRIDGE_SENTINEL_EVENT = "__lynceus_bridge_attached__";
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;

interface BindingEnvelope {
  event: string;
  payload: unknown;
  generation: number;
  sequence?: number;
}

export const reactFrameworkAdapter = Object.freeze({
  framework: "react",
  attach: attachReactDevTools,
  detach: detachReactDevTools,
}) satisfies FrameworkAdapter;

export async function attachReactDevTools(
  s: Session,
  opts: { timeoutMs?: number } = {},
): Promise<FrameworkAttachResult> {
  const existing = s.reactBridge;
  if (existing) {
    if (existing.attachPromise) await existing.attachPromise;
    return {
      framework: "react",
      status: "already-attached",
      generation: existing.generation,
      backend_version: REACT_DEVTOOLS_CORE_VERSION,
      events_buffered: s.reactEvents.size(),
    };
  }

  const generation = s.nextReactBridgeGeneration();
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const bridge: ReactBridgeState = {
    framework: "react",
    bindingName: REACT_BINDING_NAME,
    generation,
    status: "attaching",
    documentGeneration: 0,
    loaderId: s.mainFrameLoaderId,
    sentinelSeen: false,
    operationsSeen: false,
    readinessArmed: false,
    minimumAcceptedDocumentGeneration: 0,
    bindingInstallations: new Set(),
    pendingBindingInstallations: new Map(),
    resolveReady,
    readyPromise,
  };
  s.reactEvents.clear();
  s.reactBridge = bridge;
  bridge.cleanup = () => cleanupReactBridge(s, bridge);

  const client = s.client;
  if (!client) {
    s.clearReactBridge();
    throw new ToolError("no_session", "Cannot attach React DevTools without an active CDP client.");
  }

  const eventHandler = (
    params: Protocol.Runtime.BindingCalledEvent,
    eventSessionId?: string,
  ) => handleReactBindingCalled(s, bridge, params, eventSessionId);
  bridge.eventHandler = eventHandler;
  registerHandler(s, client, undefined, "Runtime.bindingCalled", eventHandler);

  const attachPromise = performAttach(
    s,
    bridge,
    opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
  ).catch(async (error) => {
    await cleanupReactBridge(s, bridge);
    throw error;
  });
  bridge.attachPromise = attachPromise;
  return await attachPromise;
}

async function performAttach(
  s: Session,
  bridge: ReactBridgeState,
  timeoutMs: number,
): Promise<FrameworkAttachResult> {
  const client = s.client!;
  if (s.mainFrameId === null) {
    const { frameTree } = await client.Page.getFrameTree();
    s.noteMainFrame(frameTree.frame.id, frameTree.frame.loaderId);
    bridge.loaderId = s.mainFrameLoaderId;
  }

  await installReactBridgeBindings(s);
  assertCurrentBridge(s, bridge);

  const bootstrap = buildReactBootstrap(bridge.generation);
  const backend = getReactBackendSource();
  const bootstrapRecord = await addPreDocumentScript(s, { source: bootstrap });
  bridge.bootstrapScriptId = bootstrapRecord.id;
  const backendRecord = await addPreDocumentScript(s, { source: backend });
  bridge.backendScriptId = backendRecord.id;
  assertCurrentBridge(s, bridge);

  // Correctness-first late attach: establish the bootstrap in the current
  // document for same-document reattach, inject the backend, then reload so
  // the same two tracked scripts run before React in the replacement document.
  await evaluateOrThrow(client, bootstrap, "React bridge bootstrap");
  await evaluateOrThrow(client, backend, "React DevTools backend");
  bridge.minimumAcceptedDocumentGeneration = bridge.documentGeneration + 1;
  bridge.readinessArmed = true;
  await client.Page.reload({ ignoreCache: false });
  await waitForReady(bridge, timeoutMs);
  assertCurrentBridge(s, bridge);
  bridge.status = "attached";
  return {
    framework: "react",
    status: "attached",
    generation: bridge.generation,
    backend_version: REACT_DEVTOOLS_CORE_VERSION,
    events_buffered: s.reactEvents.size(),
  };
}

export async function detachReactDevTools(s: Session): Promise<FrameworkDetachResult> {
  const bridge = s.reactBridge;
  if (!bridge) {
    return {
      framework: "react",
      status: "not-attached",
      generation: s.reactBridgeGeneration,
    };
  }
  await cleanupReactBridge(s, bridge);
  return {
    framework: "react",
    status: "detached",
    generation: s.reactBridgeGeneration,
  };
}

async function cleanupReactBridge(s: Session, bridge: ReactBridgeState): Promise<void> {
  if (s.reactBridge !== bridge) return;
  const client = s.client;
  if (client) {
    try {
      await client.Runtime.evaluate({
        expression:
          `globalThis.__lynceusReactDetach__?.(${bridge.generation});` +
          `\n//# sourceURL=lynceus://react-devtools/detach.js`,
        returnByValue: true,
      });
    } catch (e) {
      log.warn("failed to invoke React backend unsubscribe", { error: String(e) });
    }
  }

  if (bridge.bootstrapScriptId) {
    await removePreDocumentScript(s, bridge.bootstrapScriptId);
  }
  if (bridge.backendScriptId) {
    await removePreDocumentScript(s, bridge.backendScriptId);
  }
  await removeReactBridgeBindings(s);

  if (client && bridge.eventHandler) {
    unregisterHandler(
      s,
      client,
      undefined,
      "Runtime.bindingCalled",
      bridge.eventHandler,
    );
  }
  if (s.reactBridge === bridge) s.clearReactBridge();
}

function handleReactBindingCalled(
  s: Session,
  installedBridge: ReactBridgeState,
  params: Protocol.Runtime.BindingCalledEvent,
  eventSessionId: string | undefined,
): void {
  const bridge = s.reactBridge;
  if (
    bridge !== installedBridge ||
    params.name !== REACT_BINDING_NAME ||
    eventSessionId !== undefined ||
    !s.isMainExecutionContext(eventSessionId, params.executionContextId)
  ) {
    return;
  }

  let message: BindingEnvelope;
  try {
    message = JSON.parse(params.payload) as BindingEnvelope;
  } catch {
    log.warn("ignored malformed React bridge binding payload");
    return;
  }
  if (
    typeof message?.event !== "string" ||
    message.generation !== bridge.generation ||
    !bridge.readinessArmed ||
    bridge.documentGeneration < bridge.minimumAcceptedDocumentGeneration
  ) {
    return;
  }

  if (message.event === REACT_BRIDGE_SENTINEL_EVENT) {
    bridge.sentinelSeen = true;
  } else if (message.event === "operations") {
    bridge.operationsSeen = true;
    s.reactEvents.push({
      ts: Date.now(),
      generation: bridge.documentGeneration,
      event: message.event,
      payload: message.payload,
      executionContextId: params.executionContextId,
    });
  }

  if (bridge.sentinelSeen && bridge.operationsSeen) bridge.resolveReady();
}

function assertCurrentBridge(s: Session, bridge: ReactBridgeState): void {
  if (s.reactBridge !== bridge) {
    throw new ToolError(
      "react_bridge_cancelled",
      "React DevTools attachment was cancelled before it became ready.",
    );
  }
}

async function evaluateOrThrow(
  client: import("chrome-remote-interface").Client,
  expression: string,
  label: string,
): Promise<void> {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const description =
      details.exception?.description ??
      (details.exception?.value !== undefined
        ? String(details.exception.value)
        : details.text);
    const location =
      details.lineNumber !== undefined && details.columnNumber !== undefined
        ? ` at ${details.lineNumber + 1}:${details.columnNumber}`
        : "";
    throw new ToolError(
      "react_bridge_injection_failed",
      `${label} failed in the page${location}: ${description}`,
    );
  }
}

async function waitForReady(bridge: ReactBridgeState, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bridge.readyPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              "react_bridge_timeout",
              `React DevTools did not observe its bootstrap sentinel and first operations event within ${timeoutMs}ms. Confirm this is a supported React 16.8–19 page using a client-rendered build.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pre-document bridge bootstrap proven by LEO-213. The backend's UMD root
 * assignment hits the configurable setter synchronously; an already-present
 * backend is connected immediately so detach → same-document reattach works.
 */
export function buildReactBootstrap(generation: number): string {
  return `(() => {
  const target = globalThis;
  // Page.addScriptToEvaluateOnNewDocument runs in every frame. React v1 is
  // deliberately main-frame-only, so child realms must not initialize a
  // backend even though the server also rejects their binding events.
  if (target.top !== target) return;
  const generation = ${generation};
  const bindingName = ${JSON.stringify(REACT_BINDING_NAME)};
  const sentinelEvent = ${JSON.stringify(REACT_BRIDGE_SENTINEL_EVENT)};
  target.__LYNCEUS_BRIDGE_BOOTSTRAP__ = true;
  let backendListener = null;
  let unsubscribe = null;
  let sequence = 0;
  let backendValue = target.ReactDevToolsBackend;

  const forward = (event, payload) => {
    const binding = target[bindingName];
    if (typeof binding !== "function") return;
    binding(JSON.stringify({ event, payload, generation, sequence: ++sequence }));
  };

  const disconnectBackend = () => {
    if (typeof unsubscribe === "function") {
      try { unsubscribe(); } catch {}
    }
    unsubscribe = null;
    backendListener = null;
  };

  const detach = expectedGeneration => {
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
    disconnectBackend();
    target.__LYNCEUS_REACT_ATTACHED__ = false;
    if (target.__lynceusReactDispatch__?.__lynceusGeneration === generation) {
      delete target.__lynceusReactDispatch__;
    }
    return true;
  };

  const connect = backend => {
    if (!backend || typeof backend.connectWithCustomMessagingProtocol !== "function") return;
    disconnectBackend();
    const hookName = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
    const existingHook = target[hookName];
    // Vite's React Refresh runtime creates a minimal late-attach shim when
    // DevTools was absent at page startup. It has inject/commit callbacks but
    // not the rich backend event surface (sub, rendererInterfaces, ...).
    // Replace that configurable shim before initializing the real backend.
    if (!existingHook || typeof existingHook.sub !== "function") {
      if (Object.prototype.hasOwnProperty.call(target, hookName)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, hookName);
        if (!descriptor?.configurable || !delete target[hookName]) {
          throw new Error("Cannot replace an incompatible React DevTools hook");
        }
      }
      backend.initialize();
    }
    if (typeof target[hookName]?.sub !== "function") {
      throw new Error("React DevTools backend did not install its full hook");
    }
    const maybeUnsubscribe = backend.connectWithCustomMessagingProtocol({
      onSubscribe(listener) { backendListener = listener; },
      onUnsubscribe(listener) {
        if (backendListener === listener) backendListener = null;
      },
      onMessage(event, payload) { forward(event, payload); },
    });
    unsubscribe = typeof maybeUnsubscribe === "function" ? maybeUnsubscribe : null;
    target.__LYNCEUS_REACT_ATTACHED__ = generation;
    forward(sentinelEvent, { generation });
  };

  const dispatch = (event, payload) => {
    if (typeof backendListener === "function") {
      backendListener({ event, payload });
    }
  };
  Object.defineProperty(dispatch, "__lynceusGeneration", { value: generation });
  target.__lynceusReactDispatch__ = dispatch;
  target.__lynceusReactDetach__ = detach;

  Object.defineProperty(target, "ReactDevToolsBackend", {
    configurable: true,
    enumerable: true,
    get() { return backendValue; },
    set(value) {
      backendValue = value;
      connect(value);
    },
  });
  if (backendValue) connect(backendValue);
})();
//# sourceURL=lynceus://react-devtools/bootstrap.js`;
}
