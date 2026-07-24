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
  isRecord,
  normalizeDehydratedValue,
  ReactInspectionCoordinator,
  type ReactInspectionPath,
  type ReactInspectionReply,
} from "./react-inspection.js";
import { resolveReactSource } from "./react-source.js";
import {
  ReactComponentStore,
  reactElementTypeName,
  toReactRendererSnapshot,
  type ReactRendererMetadata,
} from "./react-store.js";
import {
  getReactBackendSource,
  REACT_DEVTOOLS_CORE_VERSION,
} from "./react-backend.js";

export const REACT_BINDING_NAME = "__lynceusReact__" as const;
export const REACT_BRIDGE_SENTINEL_EVENT = "__lynceus_bridge_attached__";
export const REACT_RENDERER_METADATA_EVENT = "__lynceus_renderer_metadata__";
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;

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
    if (existing.status === "detaching") {
      await existing.cleanupPromise;
      return attachReactDevTools(s, opts);
    }
    if (existing.status === "attaching" && existing.attachPromise) {
      await existing.attachPromise;
      // A detach can win immediately after the original attach settles. Do
      // not report already-attached for a bridge whose teardown is visible.
      if (!isAttachedBridge(s, existing)) {
        return attachReactDevTools(s, opts);
      }
    }
    return {
      framework: "react",
      status: "already-attached",
      generation: existing.generation,
      backend_version: REACT_DEVTOOLS_CORE_VERSION,
      events_buffered: s.reactEvents.size(),
    };
  }

  const client = s.client;
  if (!client) {
    throw new ToolError("no_session", "Cannot attach React DevTools without an active CDP client.");
  }

  const generation = s.nextReactBridgeGeneration();
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let resolveCancellation!: () => void;
  const cancellationPromise = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const bridge: ReactBridgeState = {
    framework: "react",
    bindingName: REACT_BINDING_NAME,
    generation,
    status: "attaching",
    cancelled: false,
    resolveCancellation,
    cancellationPromise,
    documentGeneration: 0,
    loaderId: s.mainFrameLoaderId,
    sentinelSeen: false,
    operationsSeen: false,
    readinessArmed: false,
    minimumAcceptedDocumentGeneration: 0,
    tree: new ReactComponentStore(0),
    inspections: new ReactInspectionCoordinator(),
    bindingInstallations: new Set(),
    pendingBindingInstallations: new Map(),
    resolveReady,
    readyPromise,
  };
  s.reactEvents.clear();
  s.reactBridge = bridge;
  bridge.cleanup = () => cleanupReactBridge(s, bridge);

  const eventHandler = (
    params: Protocol.Runtime.BindingCalledEvent,
    eventSessionId?: string,
  ) => handleReactBindingCalled(s, bridge, params, eventSessionId);
  bridge.eventHandler = eventHandler;
  registerHandler(s, client, undefined, "Runtime.bindingCalled", eventHandler);

  const attachWorkPromise = performAttach(
    s,
    bridge,
    opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
  );
  bridge.attachWorkPromise = attachWorkPromise;
  const attachPromise = attachWorkPromise.catch(async (error) => {
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
    assertCurrentBridge(s, bridge);
    s.noteMainFrame(frameTree.frame.id, frameTree.frame.loaderId);
    bridge.loaderId = s.mainFrameLoaderId;
  }

  await installReactBridgeBindings(s);
  assertCurrentBridge(s, bridge);

  const bootstrap = buildReactBootstrap(bridge.generation);
  const backend = getReactBackendSource();
  const bootstrapRecord = await addBridgePreDocumentScript(
    s,
    bridge,
    bootstrap,
  );
  bridge.bootstrapScriptId = bootstrapRecord.id;
  const backendRecord = await addBridgePreDocumentScript(s, bridge, backend);
  bridge.backendScriptId = backendRecord.id;
  assertCurrentBridge(s, bridge);

  // Correctness-first late attach: establish the bootstrap in the current
  // document for same-document reattach, inject the backend, then reload so
  // the same two tracked scripts run before React in the replacement document.
  await evaluateOrThrow(client, bootstrap, "React bridge bootstrap");
  assertCurrentBridge(s, bridge);
  await evaluateOrThrow(client, backend, "React DevTools backend");
  assertCurrentBridge(s, bridge);
  bridge.minimumAcceptedDocumentGeneration = bridge.documentGeneration + 1;
  bridge.readinessArmed = true;
  await client.Page.reload({ ignoreCache: false });
  assertCurrentBridge(s, bridge);
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
    generation: bridge.detachedGeneration ?? s.reactBridgeGeneration,
  };
}

function cleanupReactBridge(s: Session, bridge: ReactBridgeState): Promise<void> {
  if (bridge.cleanupPromise) return bridge.cleanupPromise;
  if (s.reactBridge !== bridge) return Promise.resolve();

  // This state transition is the lifecycle lock. Child-session replay and
  // concurrent attach calls observe it before cleanup performs any await.
  bridge.status = "detaching";
  bridge.cancelled = true;
  bridge.resolveCancellation();
  bridge.inspections.reset(
    "React DevTools was detached while component inspection was in flight.",
  );

  const client = s.client;
  if (client && bridge.eventHandler) {
    unregisterHandler(
      s,
      client,
      undefined,
      "Runtime.bindingCalled",
      bridge.eventHandler,
    );
  }

  const cleanupPromise = performReactBridgeCleanup(s, bridge, client);
  bridge.cleanupPromise = cleanupPromise;
  return cleanupPromise;
}

async function performReactBridgeCleanup(
  s: Session,
  bridge: ReactBridgeState,
  client: Session["client"],
): Promise<void> {
  // A raw attach never awaits cleanup. Waiting here makes detach completion a
  // barrier: any CDP command that was already in flight has either published
  // a tracked identifier or rolled that identifier back before the sweep.
  await bridge.attachWorkPromise?.catch(() => {});

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

  if (s.reactBridge === bridge) {
    s.clearReactBridge();
    bridge.detachedGeneration = s.reactBridgeGeneration;
  }
}

async function addBridgePreDocumentScript(
  s: Session,
  bridge: ReactBridgeState,
  source: string,
) {
  const record = await addPreDocumentScript(s, { source });
  if (s.reactBridge !== bridge || bridge.cancelled) {
    // The Page command may have returned after teardown began and before the
    // bridge could publish its logical script id. Roll it back in the same
    // operation so cleanup cannot finish with a replayable orphan.
    await removePreDocumentScript(s, record.id);
    throw reactBridgeCancelled();
  }
  return record;
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
    bridge.status === "detaching" ||
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
  } else if (message.event === REACT_RENDERER_METADATA_EVENT) {
    try {
      const metadata = parseRendererMetadata(message.payload);
      bridge.tree.updateRendererMetadata(metadata);
      const unsupported = bridge.tree.unsupportedVersionMessage();
      if (unsupported) markBridgeFailure(bridge, "unsupported", unsupported);
    } catch (error) {
      markBridgeFailure(
        bridge,
        "protocol",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (message.event === "unsupportedRendererVersion") {
    markBridgeFailure(
      bridge,
      "unsupported",
      "The attached renderer does not expose a React Fiber interface compatible with react-devtools-core@7.0.1. React read inspection supports React 16.8–19.",
    );
  } else if (message.event === "operations") {
    // Buffer first so the exact payload that trips the decoder remains
    // available for diagnostics even though the materialized tree rejects it.
    s.reactEvents.push({
      ts: Date.now(),
      generation: bridge.documentGeneration,
      event: message.event,
      payload: message.payload,
      executionContextId: params.executionContextId,
    });
    try {
      bridge.tree.apply(message.payload, bridge.documentGeneration);
      bridge.mainExecutionContextId = params.executionContextId;
      bridge.operationsSeen = true;
    } catch (error) {
      markBridgeFailure(
        bridge,
        "protocol",
        `Could not decode React operations: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (message.event === "inspectedElement") {
    if (!bridge.inspections.handle(message.payload)) {
      log.warn("ignored unmatched React inspectedElement reply");
    }
  }

  if (bridge.sentinelSeen && bridge.operationsSeen) bridge.resolveReady();
}

function isAttachedBridge(s: Session, bridge: ReactBridgeState): boolean {
  return s.reactBridge === bridge && bridge.status === "attached";
}

function reactBridgeCancelled(): ToolError {
  return new ToolError(
    "react_bridge_cancelled",
    "React DevTools attachment was cancelled before it became ready.",
  );
}

function assertCurrentBridge(s: Session, bridge: ReactBridgeState): void {
  if (s.reactBridge !== bridge || bridge.cancelled) throw reactBridgeCancelled();
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
      bridge.cancellationPromise.then(() => {
        throw reactBridgeCancelled();
      }),
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
    if (bridge.unsupportedVersion) {
      throw new ToolError("unsupported_react_version", bridge.unsupportedVersion);
    }
    if (bridge.protocolError) {
      throw new ToolError("react_protocol_error", bridge.protocolError);
    }
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
  const rendererMetadataEvent = ${JSON.stringify(REACT_RENDERER_METADATA_EVENT)};
  target.__LYNCEUS_BRIDGE_BOOTSTRAP__ = true;
  let backendListener = null;
  let unsubscribe = null;
  let sequence = 0;
  let backendValue = target.ReactDevToolsBackend;
  const forwardedRendererMetadata = new Set();

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

  const forwardRenderer = payload => {
    const rendererID = Array.isArray(payload) ? payload[0] : null;
    if (!Number.isInteger(rendererID) || forwardedRendererMetadata.has(rendererID)) return;
    const renderer = target.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.get?.(rendererID);
    if (!renderer) return;
    forwardedRendererMetadata.add(rendererID);
    forward(rendererMetadataEvent, {
      rendererId: rendererID,
      bundleType: typeof renderer.bundleType === "number" ? renderer.bundleType : null,
      version: typeof renderer.version === "string" ? renderer.version : null,
      rendererPackageName:
        typeof renderer.rendererPackageName === "string" ? renderer.rendererPackageName : null,
      supportsFiber:
        typeof renderer.getCurrentComponentInfo === "function" ||
        typeof renderer.findFiberByHostInstance === "function" ||
        renderer.currentDispatcherRef != null,
    });
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
      onMessage(event, payload) {
        if (event === "operations") forwardRenderer(payload);
        forward(event, payload);
      },
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

function markBridgeFailure(
  bridge: ReactBridgeState,
  kind: "protocol" | "unsupported",
  message: string,
): void {
  const failureMessage =
    kind === "protocol"
      ? `${message} Detach and reattach React DevTools to resynchronize the component tree.`
      : message;
  if (kind === "protocol") bridge.protocolError ??= failureMessage;
  else bridge.unsupportedVersion ??= failureMessage;
  bridge.inspections.reset(failureMessage);
  // Resolve rather than reject: this signal may be delivered synchronously
  // during backend evaluation, before performAttach awaits readyPromise.
  // waitForReady turns the recorded failure into the structured ToolError.
  bridge.resolveReady();
}

function parseRendererMetadata(payload: unknown): ReactRendererMetadata {
  if (!isRecord(payload) || !Number.isSafeInteger(payload.rendererId)) {
    throw new ToolError("react_protocol_error", "React renderer metadata is malformed.");
  }
  const rendererId = payload.rendererId as number;
  if (rendererId <= 0) {
    throw new ToolError("react_protocol_error", "React renderer id must be positive.");
  }
  const bundleType = payload.bundleType;
  const version = payload.version;
  const rendererPackageName = payload.rendererPackageName;
  const supportsFiber = payload.supportsFiber;
  if (
    (bundleType !== null && !Number.isSafeInteger(bundleType)) ||
    (version !== null && typeof version !== "string") ||
    (rendererPackageName !== null && typeof rendererPackageName !== "string") ||
    (supportsFiber !== null && typeof supportsFiber !== "boolean")
  ) {
    throw new ToolError("react_protocol_error", "React renderer metadata fields are malformed.");
  }
  return {
    rendererId,
    bundleType: bundleType as number | null,
    version: version as string | null,
    rendererPackageName: rendererPackageName as string | null,
    supportsFiber: supportsFiber as boolean | null,
  };
}

export interface InspectReactComponentOptions {
  componentId: number;
  rendererId?: number;
  path?: ReactInspectionPath;
  timeoutMs?: number;
}

export async function inspectReactComponent(
  s: Session,
  bridge: ReactBridgeState,
  options: InspectReactComponentOptions,
): Promise<Record<string, unknown>> {
  const renderers = bridge.tree.renderersFor(options.componentId);
  const rendererId = options.rendererId ?? (renderers.length === 1 ? renderers[0] : undefined);
  if (rendererId === undefined) {
    if (renderers.length === 0) {
      throw new ToolError(
        "react_component_not_found",
        `No component with id ${options.componentId} exists in React tree generation ${bridge.documentGeneration}. Call find_react_component or get_react_tree to refresh ids.`,
      );
    }
    throw new ToolError(
      "ambiguous_react_component",
      `Component id ${options.componentId} exists in renderers ${renderers.join(", ")}. Pass renderer_id to select one.`,
    );
  }
  const record = bridge.tree.get(options.componentId, rendererId);
  if (!record) {
    throw new ToolError(
      "react_component_not_found",
      `No component ${rendererId}:${options.componentId} exists in React tree generation ${bridge.documentGeneration}. Call find_react_component or get_react_tree to refresh ids.`,
    );
  }
  const client = s.client;
  if (!client || bridge.mainExecutionContextId === undefined) {
    throw new ToolError(
      "no_react_bridge",
      "The React bridge has no current main-frame execution context. Reattach React DevTools.",
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
  const request = async (
    path: ReactInspectionPath | null,
    forceFullData: boolean,
  ): Promise<ReactInspectionReply> =>
    await bridge.inspections.request(
      {
        rendererId,
        componentId: options.componentId,
        path,
        forceFullData,
        timeoutMs,
      },
      async (requestId) => {
        const payload = {
          forceFullData,
          id: options.componentId,
          path,
          rendererID: rendererId,
          requestID: requestId,
        };
        const result = await client.Runtime.evaluate({
          expression: `(() => { const dispatch = globalThis.__lynceusReactDispatch__; if (typeof dispatch !== "function") throw new Error("React bridge dispatcher is unavailable"); dispatch("inspectElement", ${JSON.stringify(payload)}); return true; })()\n//# sourceURL=lynceus://react-devtools/inspect.js`,
          contextId: bridge.mainExecutionContextId,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          throw new ToolError(
            "react_inspection_failed",
            result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text ??
              "React inspectElement dispatch failed in the page.",
          );
        }
      },
    );

  let baseReply = await request(
    null,
    !bridge.inspections.hasCached(rendererId, options.componentId),
  );
  const base = unwrapInspectionReply(baseReply, rendererId, options.componentId);
  let hydratedPath: Record<string, unknown> | null = null;
  if (options.path) {
    const hydrationReply = await request(options.path, false);
    if (hydrationReply.kind === "hydrated-path") {
      hydratedPath = {
        path: hydrationReply.path,
        value: normalizeDehydratedValue(hydrationReply.value),
      };
    } else {
      // A render can race the path request and legitimately produce a fresh
      // full-data reply. Prefer those newer values; the backend has already
      // recorded the requested path for the dehydration pass.
      baseReply = hydrationReply;
      Object.assign(base, unwrapInspectionReply(baseReply, rendererId, options.componentId));
    }
  }

  const raw = base.value;
  const rendererPackageName =
    typeof raw.rendererPackageName === "string" ? raw.rendererPackageName : null;
  const rendererVersion = typeof raw.rendererVersion === "string" ? raw.rendererVersion : null;
  const existingMetadata = bridge.tree.getRendererMetadata(rendererId);
  if (rendererPackageName !== null || rendererVersion !== null) {
    bridge.tree.updateRendererMetadata({
      rendererId,
      bundleType: existingMetadata?.bundleType ?? null,
      rendererPackageName: rendererPackageName ?? existingMetadata?.rendererPackageName ?? null,
      version: rendererVersion ?? existingMetadata?.version ?? null,
      supportsFiber: existingMetadata?.supportsFiber ?? null,
    });
  }
  const source = await resolveReactSource(
    s.scripts,
    raw.source,
    bridge.mainExecutionContextId,
    null,
  );
  const rendererMetadata = bridge.tree.getRendererMetadata(rendererId);
  return {
    generation: bridge.documentGeneration,
    bridge_generation: bridge.generation,
    document_generation: bridge.documentGeneration,
    response_type: baseReply.kind,
    component_id: options.componentId,
    renderer_id: rendererId,
    root_id: record.rootId,
    display_name: record.displayName,
    type: reactElementTypeName(record.type),
    key: raw.key ?? record.key,
    // react-devtools-core@7 cleans these categories independently from an
    // empty path. Prefix their relative metadata so callers can round-trip a
    // returned cleaned_paths entry directly as the next inspect path.
    props: normalizeDehydratedValue(raw.props, ["props"]),
    state: normalizeDehydratedValue(raw.state, ["state"]),
    hooks: normalizeDehydratedValue(raw.hooks, ["hooks"]),
    context: normalizeDehydratedValue(raw.context, ["context"]),
    suspended_by: normalizeDehydratedValue(raw.suspendedBy, ["suspendedBy"]),
    component_errors: Array.isArray(raw.errors) ? raw.errors : [],
    component_warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    capabilities: {
      can_edit_hooks: raw.canEditHooks === true,
      can_edit_function_props: raw.canEditFunctionProps === true,
      can_toggle_error: raw.canToggleError === true,
      can_toggle_suspense: raw.canToggleSuspense === true,
    },
    is_errored: raw.isErrored === true,
    is_suspended: typeof raw.isSuspended === "boolean" ? raw.isSuspended : null,
    has_legacy_context: raw.hasLegacyContext === true,
    renderer: rendererMetadata ? toReactRendererSnapshot(rendererMetadata) : null,
    ...source,
    hydrated_path: hydratedPath,
    warnings: bridge.tree.readWarnings(),
  };
}

function unwrapInspectionReply(
  reply: ReactInspectionReply,
  rendererId: number,
  componentId: number,
): { value: Record<string, unknown> } {
  switch (reply.kind) {
    case "full-data":
    case "no-change":
      return { value: reply.value };
    case "not-found":
      throw new ToolError(
        "react_component_not_found",
        `React renderer ${rendererId} no longer contains component ${componentId}. Refresh the tree and retry with a current id.`,
      );
    case "error":
      throw new ToolError(
        "react_inspection_failed",
        `React DevTools could not inspect ${rendererId}:${componentId} (${reply.errorType}): ${reply.message}${reply.stack ? `\n${reply.stack}` : ""}`,
      );
    case "hydrated-path":
      throw new ToolError(
        "react_protocol_error",
        "React DevTools returned a hydrated-path response for a full component request.",
      );
  }
}
