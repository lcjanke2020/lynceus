import { describe, expect, it, vi } from "vitest";
import { SourceMapGenerator } from "@jridgewell/source-map";
import { registerReactTools } from "../../src/tools/react.js";
import { registry, requireReactBridge } from "../../src/session/state.js";
import {
  REACT_BINDING_NAME,
  REACT_BRIDGE_SENTINEL_EVENT,
  REACT_RENDERER_METADATA_EVENT,
} from "../../src/framework/react.js";
import { setupAdditionalSession, setupSession, autoReset } from "../setup.js";
import {
  captureTools,
  parseErrorEnvelope,
  parseOkEnvelope,
} from "../handler-registry.js";
import type { FakeCdp } from "../fake-cdp.js";
import type { Session } from "../../src/session/state.js";

autoReset();

const tools = captureTools(registerReactTools);
const attach = tools.get("attach_react_devtools")!;
const getTree = tools.get("get_react_tree")!;
const findComponent = tools.get("find_react_component")!;
const inspectComponent = tools.get("inspect_react_component")!;
const detach = tools.get("detach_react_devtools")!;

// Canned v7 payload shaped from the real S3 spike capture; operand order is
// pinned in docs/react-devtools-design.md §3.9. String ids are App,
// InspectorWidget, Row, a, b. Host nodes are absent by backend design.
const MATERIALIZED_TREE_OPERATIONS = [
  1, 1, 28,
  3, 65, 112, 112,
  15, 73, 110, 115, 112, 101, 99, 116, 111, 114, 87, 105, 100, 103, 101, 116,
  3, 82, 111, 119,
  1, 97,
  1, 98,
  1, 1, 11, 0, 0, 1, 1,
  1, 2, 5, 1, 0, 1, 0, 0,
  1, 3, 5, 2, 2, 2, 0, 0,
  1, 4, 5, 2, 2, 3, 4, 0,
  1, 5, 5, 2, 2, 3, 5, 0,
  3, 2, 3, 3, 4, 5,
];

function seedMainDocument(session: Session): void {
  session.noteMainFrame("main-frame", "loader-before-attach");
  session.recordExecutionContext(undefined, {
    id: 1,
    frameId: "main-frame",
    isDefault: true,
  });
}

function envelope(
  generation: number,
  event: string,
  payload: unknown,
): string {
  return JSON.stringify({ event, payload, generation, sequence: 1 });
}

function fireBridgeEvent(
  fake: FakeCdp,
  session: Session,
  event: string,
  payload: unknown,
): void {
  fake.fireBindingCalled({
    name: REACT_BINDING_NAME,
    executionContextId: 1,
    payload: envelope(session.reactBridge!.generation, event, payload),
  });
}

function seedMaterializedTree(
  fake: FakeCdp,
  session: Session,
  bundleType = 1,
  version = "18.3.1",
): void {
  fireBridgeEvent(fake, session, REACT_RENDERER_METADATA_EVENT, {
    rendererId: 1,
    bundleType,
    version,
    rendererPackageName: "react-dom",
    supportsFiber: true,
  });
  fireBridgeEvent(fake, session, "operations", MATERIALIZED_TREE_OPERATIONS);
}

function inspectRequestFromExpression(expression: string): {
  id: number;
  rendererID: number;
  requestID: number;
  path: Array<string | number> | null;
  forceFullData: boolean;
} | null {
  const marker = 'dispatch("inspectElement", ';
  const start = expression.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const end = expression.indexOf("); return true;", jsonStart);
  if (end < 0) throw new Error("Malformed inspect expression in test");
  return JSON.parse(expression.slice(jsonStart, end));
}

function installInspectionReplies(
  fake: FakeCdp,
  session: Session,
  reply: (
    request: NonNullable<ReturnType<typeof inspectRequestFromExpression>>,
    call: number,
  ) => unknown,
): void {
  let call = 0;
  fake.onSend("Runtime.evaluate", (params) => {
    const request = inspectRequestFromExpression(params.expression);
    if (!request) return;
    call += 1;
    fireBridgeEvent(fake, session, "inspectedElement", reply(request, call));
  });
}

function fullInspection(requestID: number): Record<string, unknown> {
  return {
    id: 3,
    responseID: requestID,
    type: "full-data",
    value: {
      id: 3,
      type: 5,
      key: null,
      props: {
        data: {
          label: "alpha",
          settings: { inspectable: true, type: "object", preview_short: "{…}" },
        },
        cleaned: [["props", "settings"]],
        unserializable: [],
      },
      state: { data: null, cleaned: [], unserializable: [] },
      hooks: {
        data: [{ id: 0, name: "State", value: 2, subHooks: [] }],
        cleaned: [],
        unserializable: [],
      },
      context: { data: { theme: "dark" }, cleaned: [], unserializable: [] },
      suspendedBy: { data: [], cleaned: [], unserializable: [] },
      source: ["InspectorWidget", "http://localhost/assets/app.js", 10, 20],
      rendererPackageName: "react-dom",
      rendererVersion: "18.3.1",
      errors: [],
      warnings: [],
      canEditHooks: true,
      canEditFunctionProps: true,
      canToggleError: false,
      canToggleSuspense: false,
      isErrored: false,
      isSuspended: null,
      hasLegacyContext: false,
    },
  };
}

function readyOnReload(
  fake: FakeCdp,
  session: Session,
  beforeReady?: (generation: number) => void,
): void {
  let reloadCount = 0;
  fake.onSend("Page.reload", () => {
    reloadCount += 1;
    const generation = session.reactBridge!.generation;
    session.noteMainFrame(
      "main-frame",
      reloadCount === 1
        ? "loader-after-reload"
        : `loader-after-reload-${reloadCount}`,
    );
    session.clearExecutionContexts(undefined);
    session.recordExecutionContext(undefined, {
      id: 1,
      frameId: "main-frame",
      isDefault: true,
    });
    beforeReady?.(generation);
    fake.fireBindingCalled({
      name: REACT_BINDING_NAME,
      executionContextId: 1,
      payload: envelope(generation, REACT_BRIDGE_SENTINEL_EVENT, { generation }),
    });
    fake.fireBindingCalled({
      name: REACT_BINDING_NAME,
      executionContextId: 1,
      payload: envelope(generation, "operations", [1, 1, 0]),
    });
  });
}

async function attachReady(fake: FakeCdp, session: Session, sessionId?: string) {
  seedMainDocument(session);
  readyOnReload(fake, session);
  return parseOkEnvelope<{
    framework: "react";
    status: "attached" | "already-attached";
    generation: number;
    backend_version: string;
    events_buffered: number;
  }>(await attach.handler({ session: sessionId, timeout_ms: 500 }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("React DevTools tools — attach lifecycle", () => {
  it("installs binding + ordered pre-document scripts and waits for main-frame operations", async () => {
    const { fake, session, sessionId } = setupSession();
    const result = await attachReady(fake, session, sessionId);

    expect(result).toMatchObject({
      framework: "react",
      status: "attached",
      backend_version: "7.0.1",
      events_buffered: 1,
    });
    expect(session.reactBridge).toMatchObject({
      status: "attached",
      sentinelSeen: true,
      operationsSeen: true,
      documentGeneration: 1,
    });
    expect(requireReactBridge(session)).toBe(session.reactBridge);

    const methods = fake.sentCalls.map((call) => call.method);
    expect(methods.indexOf("Runtime.addBinding")).toBeLessThan(
      methods.indexOf("Page.addScriptToEvaluateOnNewDocument"),
    );
    const scripts = fake.sentCalls.filter(
      (call) => call.method === "Page.addScriptToEvaluateOnNewDocument",
    );
    expect(scripts).toHaveLength(2);
    expect(scripts[0]!.params.source).toContain("__LYNCEUS_BRIDGE_BOOTSTRAP__");
    expect(scripts[0]!.params.source).toContain("target.top !== target");
    expect(scripts[0]!.params.source).toContain('typeof existingHook.sub !== "function"');
    expect(scripts[0]!.params.source).toContain("backendListener({ event, payload })");
    expect(scripts[1]!.params.source).toContain("connectWithCustomMessagingProtocol");
    expect(methods.at(-1)).toBe("Page.reload");

    const events = session.reactEvents.query();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      generation: 1,
      event: "operations",
      payload: [1, 1, 0],
      executionContextId: 1,
    });
  });

  it("is idempotent after attach and does not duplicate CDP registrations", async () => {
    const { fake, session, sessionId } = setupSession();
    const first = await attachReady(fake, session, sessionId);
    fake.clearSentCalls();

    const second = parseOkEnvelope<{
      status: string;
      generation: number;
      events_buffered: number;
    }>(await attach.handler({ session: sessionId, timeout_ms: 500 }));

    expect(second).toEqual(
      expect.objectContaining({
        status: "already-attached",
        generation: first.generation,
        events_buffered: 1,
      }),
    );
    expect(fake.sentCalls).toEqual([]);
  });

  it("does not let late events from the pre-reload document satisfy readiness", async () => {
    const { fake, session, sessionId } = setupSession();
    seedMainDocument(session);
    fake.respond("Page.reload", () => {
      const generation = session.reactBridge!.generation;
      // These represent queued Runtime.bindingCalled events from evaluating
      // the backend in the old document. Readiness is armed by now, but the
      // loader/document generation has not advanced yet.
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 1,
        payload: envelope(generation, REACT_BRIDGE_SENTINEL_EVENT, {}),
      });
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 1,
        payload: envelope(generation, "operations", [777]),
      });

      session.noteMainFrame("main-frame", "loader-after-reload");
      session.clearExecutionContexts(undefined);
      session.recordExecutionContext(undefined, {
        id: 1,
        frameId: "main-frame",
        isDefault: true,
      });
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 1,
        payload: envelope(generation, REACT_BRIDGE_SENTINEL_EVENT, {}),
      });
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 1,
        payload: envelope(generation, "operations", [1, 1, 0]),
      });
    });

    const result = parseOkEnvelope<{ events_buffered: number }>(
      await attach.handler({ session: sessionId, timeout_ms: 500 }),
    );
    expect(result.events_buffered).toBe(1);
    expect(session.reactEvents.query().map((event) => event.payload)).toEqual([
      [1, 1, 0],
    ]);
  });

  it("ignores wrong-generation and same-process iframe messages", async () => {
    const { fake, session, sessionId } = setupSession();
    seedMainDocument(session);
    readyOnReload(fake, session, (generation) => {
      session.recordExecutionContext(undefined, {
        id: 2,
        frameId: "child-frame",
        isDefault: true,
      });
      for (const [executionContextId, messageGeneration] of [
        [2, generation],
        [1, generation - 1],
      ] as const) {
        fake.fireBindingCalled({
          name: REACT_BINDING_NAME,
          executionContextId,
          payload: envelope(messageGeneration, REACT_BRIDGE_SENTINEL_EVENT, {}),
        });
        fake.fireBindingCalled({
          name: REACT_BINDING_NAME,
          executionContextId,
          payload: envelope(messageGeneration, "operations", [99]),
        });
      }
    });

    const result = parseOkEnvelope<{ events_buffered: number }>(
      await attach.handler({ session: sessionId, timeout_ms: 500 }),
    );
    expect(result.events_buffered).toBe(1);
    expect(session.reactEvents.query().map((event) => event.payload)).toEqual([
      [1, 1, 0],
    ]);
  });

  it("cancels an attach blocked in script registration and rolls back the late identifier", async () => {
    const { fake, session, sessionId } = setupSession();
    seedMainDocument(session);
    const firstInstall = deferred<{ identifier: string }>();
    let installCount = 0;
    fake.respond("Page.addScriptToEvaluateOnNewDocument", () => {
      installCount += 1;
      if (installCount === 1) return firstInstall.promise;
      return { identifier: `unexpected-script-${installCount}` };
    });

    const attachPromise = attach.handler({ session: sessionId, timeout_ms: 500 });
    await vi.waitFor(() => {
      expect(
        fake.sentCalls.filter(
          (call) => call.method === "Page.addScriptToEvaluateOnNewDocument",
        ),
      ).toHaveLength(1);
    });

    const detachPromise = detach.handler({ session: sessionId });
    expect(session.reactBridge?.status).toBe("detaching");
    firstInstall.resolve({ identifier: "late-bootstrap-script" });

    const [attachResponse, detachResponse] = await Promise.all([
      attachPromise,
      detachPromise,
    ]);
    expect(parseErrorEnvelope(attachResponse)?.error).toBe(
      "react_bridge_cancelled",
    );
    expect(parseOkEnvelope<{ status: string }>(detachResponse).status).toBe(
      "detached",
    );
    expect(session.reactBridge).toBeNull();
    expect(session.preDocumentScripts.size).toBe(0);
    expect(fake.sentCalls).toContainEqual({
      method: "Page.removeScriptToEvaluateOnNewDocument",
      params: { identifier: "late-bootstrap-script" },
      sessionId: undefined,
    });
    expect(
      fake.sentCalls.filter((call) => call.method === "Runtime.removeBinding"),
    ).toHaveLength(1);
  });

  it("settles an attach waiting for readiness as cancelled when detach completes", async () => {
    const { fake, session, sessionId } = setupSession();
    seedMainDocument(session);
    const reloadReached = deferred<void>();
    fake.onSend("Page.reload", () => reloadReached.resolve());

    const attachPromise = attach.handler({ session: sessionId, timeout_ms: 1_000 });
    await reloadReached.promise;
    const detachResponse = await detach.handler({ session: sessionId });
    const attachResponse = await attachPromise;

    expect(parseOkEnvelope<{ status: string }>(detachResponse).status).toBe(
      "detached",
    );
    expect(parseErrorEnvelope(attachResponse)?.error).toBe(
      "react_bridge_cancelled",
    );
    expect(session.reactBridge).toBeNull();
  });

  it("serializes a new attach behind an in-flight detach", async () => {
    const { fake, session, sessionId } = setupSession();
    const firstAttach = await attachReady(fake, session, sessionId);
    const detachEvaluate = deferred<{
      result: { type: "undefined" };
    }>();
    const detachStarted = deferred<void>();
    let evaluateCount = 0;
    fake.respond("Runtime.evaluate", () => {
      evaluateCount += 1;
      if (evaluateCount === 1) {
        detachStarted.resolve();
        return detachEvaluate.promise;
      }
      return { result: { type: "undefined" } };
    });

    const detachPromise = detach.handler({ session: sessionId });
    await detachStarted.promise;
    const reattachPromise = attach.handler({
      session: sessionId,
      timeout_ms: 500,
    });
    let reattachSettled = false;
    void reattachPromise.then(() => {
      reattachSettled = true;
    });
    await Promise.resolve();
    expect(reattachSettled).toBe(false);

    detachEvaluate.resolve({ result: { type: "undefined" } });
    const [detachResponse, reattachResponse] = await Promise.all([
      detachPromise,
      reattachPromise,
    ]);
    const detached = parseOkEnvelope<{ generation: number; status: string }>(
      detachResponse,
    );
    const reattached = parseOkEnvelope<{
      generation: number;
      status: string;
    }>(reattachResponse);
    expect(detached.status).toBe("detached");
    expect(reattached.status).toBe("attached");
    expect(detached.generation).toBeGreaterThan(firstAttach.generation);
    expect(reattached.generation).toBeGreaterThan(detached.generation);
    expect(session.reactBridge?.generation).toBe(reattached.generation);
  });

  it("times out and rolls back when only a non-main-frame backend responds", async () => {
    const { fake, session, sessionId } = setupSession();
    seedMainDocument(session);
    fake.onSend("Page.reload", () => {
      const generation = session.reactBridge!.generation;
      session.recordExecutionContext(undefined, {
        id: 2,
        frameId: "child-frame",
        isDefault: true,
      });
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 2,
        payload: envelope(generation, REACT_BRIDGE_SENTINEL_EVENT, {}),
      });
      fake.fireBindingCalled({
        name: REACT_BINDING_NAME,
        executionContextId: 2,
        payload: envelope(generation, "operations", [99]),
      });
    });

    const response = await attach.handler({ session: sessionId, timeout_ms: 100 });
    expect(parseErrorEnvelope(response)).toMatchObject({
      error: "react_bridge_timeout",
    });
    expect(session.reactBridge).toBeNull();
    expect(session.reactEvents.size()).toBe(0);
    expect(fake.sentCalls.filter((call) => call.method === "Runtime.removeBinding")).toHaveLength(1);
    expect(
      fake.sentCalls.filter(
        (call) => call.method === "Page.removeScriptToEvaluateOnNewDocument",
      ),
    ).toHaveLength(2);
  });

  it("resets buffered operations only when the main-frame loader changes", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    const bridge = requireReactBridge(session);
    const originalGeneration = bridge.documentGeneration;

    session.noteMainFrame("main-frame", "loader-after-reload");
    expect(bridge.documentGeneration).toBe(originalGeneration);
    expect(bridge.operationsSeen).toBe(true);
    expect(session.reactEvents.size()).toBe(1);

    session.noteMainFrame("main-frame", "loader-next-document");
    expect(bridge.documentGeneration).toBe(originalGeneration + 1);
    expect(bridge.sentinelSeen).toBe(false);
    expect(bridge.operationsSeen).toBe(false);
    expect(session.reactEvents.size()).toBe(0);
  });
});

describe("React DevTools tools — materialized reads", () => {
  it("returns no_react_bridge for every read tool before attachment", async () => {
    const { fake, sessionId } = setupSession();
    for (const [tool, args] of [
      [getTree, {}],
      [findComponent, { name: "App" }],
      [inspectComponent, { component_id: 1 }],
    ] as const) {
      expect(
        parseErrorEnvelope(await tool.handler({ session: sessionId, ...args }))?.error,
      ).toBe("no_react_bridge");
    }
    expect(fake.sentCalls).toEqual([]);
  });

  it("returns bounded snapshots and deterministic capped display-name matches", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);

    const tree = parseOkEnvelope<any>(
      await getTree.handler({
        session: sessionId,
        max_depth: 1,
        max_children: 10,
        max_nodes: 100,
      }),
    );
    expect(tree).toMatchObject({
      generation: 1,
      total_nodes: 5,
      returned_nodes: 2,
      truncated: true,
      truncation_reasons: ["max_depth"],
      warnings: [],
      roots: [
        {
          component_id: 1,
          renderer_id: 1,
          type: "root",
          path: "root[1:1]",
          children: [
            {
              component_id: 2,
              display_name: "App",
              path: "root[1:1] > App[1:2]",
              truncated_children: 3,
            },
          ],
        },
      ],
    });

    const found = parseOkEnvelope<any>(
      await findComponent.handler({
        session: sessionId,
        name: "row",
        exact: true,
        max_results: 1,
      }),
    );
    expect(found).toMatchObject({
      query: "row",
      total_matches: 2,
      returned_matches: 1,
      truncated: true,
      matches: [
        {
          component_id: 4,
          renderer_id: 1,
          display_name: "Row",
          path: "root[1:1] > App[1:2] > Row[1:4]",
        },
      ],
    });
  });

  it("retains tree state for bfcache and resets it for a new loader generation", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);
    const bridge = requireReactBridge(session);
    expect(bridge.tree.size()).toBe(5);

    session.noteMainFrame("main-frame", "loader-after-reload");
    expect(bridge.tree.size()).toBe(5);
    expect(parseOkEnvelope<any>(await getTree.handler({ session: sessionId })).total_nodes).toBe(5);

    session.noteMainFrame("main-frame", "next-loader");
    expect(bridge.tree.size()).toBe(0);
    expect(parseErrorEnvelope(await getTree.handler({ session: sessionId }))?.error).toBe(
      "no_react_bridge",
    );

    session.clearExecutionContexts(undefined);
    session.recordExecutionContext(undefined, {
      id: 1,
      frameId: "main-frame",
      isDefault: true,
    });
    fireBridgeEvent(fake, session, REACT_BRIDGE_SENTINEL_EVENT, {});
    seedMaterializedTree(fake, session);
    const next = parseOkEnvelope<any>(await getTree.handler({ session: sessionId }));
    expect(next).toMatchObject({ generation: 2, total_nodes: 5 });
  });

  it("warns but continues for production and keeps the version guard dormant for 16.8–19", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session, 0, "16.8.0");

    const tree = parseOkEnvelope<any>(await getTree.handler({ session: sessionId }));
    expect(tree.total_nodes).toBe(5);
    expect(tree.warnings).toEqual([
      expect.objectContaining({
        code: "production_build_detected",
        renderer_id: 1,
        renderer_version: "16.8.0",
      }),
    ]);
    expect(
      parseOkEnvelope<any>(
        await findComponent.handler({ session: sessionId, name: "App" }),
      ).warnings[0].code,
    ).toBe("production_build_detected");

    fireBridgeEvent(fake, session, REACT_RENDERER_METADATA_EVENT, {
      rendererId: 1,
      bundleType: 1,
      version: "19.1.0",
      rendererPackageName: "react-dom",
      supportsFiber: true,
    });
    expect(parseErrorEnvelope(await getTree.handler({ session: sessionId }))).toBeNull();
  });

  it("rejects a dormant pre-Fiber guard and malformed operations without serving stale state", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);

    fireBridgeEvent(fake, session, "operations", [1, 1, 0, 99]);
    expect(parseErrorEnvelope(await getTree.handler({ session: sessionId }))).toMatchObject({
      error: "react_protocol_error",
    });
    expect(session.reactBridge?.tree.size()).toBe(5);

    session.noteMainFrame("main-frame", "new-document");
    session.clearExecutionContexts(undefined);
    session.recordExecutionContext(undefined, {
      id: 1,
      frameId: "main-frame",
      isDefault: true,
    });
    fireBridgeEvent(fake, session, REACT_BRIDGE_SENTINEL_EVENT, {});
    seedMaterializedTree(fake, session);
    fireBridgeEvent(fake, session, REACT_RENDERER_METADATA_EVENT, {
      rendererId: 1,
      bundleType: 1,
      version: "15.6.2",
      rendererPackageName: "react-dom",
      supportsFiber: false,
    });
    expect(parseErrorEnvelope(await getTree.handler({ session: sessionId }))).toMatchObject({
      error: "unsupported_react_version",
    });
  });
});

describe("React DevTools tools — live component inspection", () => {
  it("correlates full/no-change replies, hydrates a path, and maps source to TypeScript", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);

    const map = new SourceMapGenerator({ file: "app.js" });
    map.addMapping({
      generated: { line: 10, column: 19 },
      original: { line: 42, column: 4 },
      source: "src/InspectorWidget.tsx",
    });
    session.scripts.upsert({
      scriptId: "app-script",
      url: "http://localhost/assets/app.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "app",
    });
    session.scripts.attachMap("app-script", undefined, map.toString());

    installInspectionReplies(fake, session, (request) => {
      if (request.path) {
        return {
          id: 3,
          responseID: request.requestID,
          type: "hydrated-path",
          path: request.path,
          value: {
            data: { fontScale: 1 },
            cleaned: [],
            unserializable: [],
          },
        };
      }
      if (!request.forceFullData) {
        return { id: 3, responseID: request.requestID, type: "no-change" };
      }
      return fullInspection(request.requestID);
    });

    const inspected = parseOkEnvelope<any>(
      await inspectComponent.handler({
        session: sessionId,
        component_id: 3,
        renderer_id: 1,
        path: ["props", "settings"],
      }),
    );
    expect(inspected).toMatchObject({
      generation: 1,
      response_type: "full-data",
      component_id: 3,
      renderer_id: 1,
      display_name: "InspectorWidget",
      props: {
        data: { label: "alpha" },
        cleaned_paths: [["props", "settings"]],
      },
      hooks: { data: [{ name: "State", value: 2 }] },
      context: { data: { theme: "dark" } },
      hydrated_path: {
        path: ["props", "settings"],
        value: { data: { fontScale: 1 }, cleaned_paths: [] },
      },
      source: {
        file: "src/InspectorWidget.tsx",
        line: 42,
        column: 4,
        generated: { script_id: "app-script", session_id: null },
      },
      source_note: null,
      warnings: [],
    });
    expect(inspected.props.data.settings).toMatchObject({ inspectable: true });

    const unchanged = parseOkEnvelope<any>(
      await inspectComponent.handler({
        session: sessionId,
        component_id: 3,
        renderer_id: 1,
      }),
    );
    expect(unchanged.response_type).toBe("no-change");
    expect(unchanged.props.data.label).toBe("alpha");
    expect(
      fake.sentCalls
        .filter(
          (call) =>
            call.method === "Runtime.evaluate" &&
            call.params.expression.includes('dispatch("inspectElement"'),
        )
        .every((call) => call.params.contextId === 1),
    ).toBe(true);
  });

  it("handles not-found and backend error responses as structured tool errors", async () => {
    for (const replyKind of ["not-found", "error"] as const) {
      const { fake, session, sessionId } = setupSession();
      await attachReady(fake, session, sessionId);
      seedMaterializedTree(fake, session);
      installInspectionReplies(fake, session, (request) =>
        replyKind === "not-found"
          ? { id: 3, responseID: request.requestID, type: "not-found" }
          : {
              id: 3,
              responseID: request.requestID,
              type: "error",
              errorType: "user",
              message: "hook inspection exploded",
            },
      );
      const error = parseErrorEnvelope(
        await inspectComponent.handler({
          session: sessionId,
          component_id: 3,
          renderer_id: 1,
        }),
      );
      expect(error?.error).toBe(
        replyKind === "not-found"
          ? "react_component_not_found"
          : "react_inspection_failed",
      );
    }
  });

  it("returns a normal null-source note for a structural component", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);
    installInspectionReplies(fake, session, (request) => {
      const reply = fullInspection(request.requestID);
      (reply.value as Record<string, unknown>).source = null;
      return reply;
    });
    const inspected = parseOkEnvelope<any>(
      await inspectComponent.handler({
        session: sessionId,
        component_id: 3,
        renderer_id: 1,
      }),
    );
    expect(inspected.source).toBeNull();
    expect(inspected.source_note).toContain("normal");
  });

  it("rejects stale/ambiguous ids before dispatching inspectElement", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    seedMaterializedTree(fake, session);
    fake.clearSentCalls();

    expect(
      parseErrorEnvelope(
        await inspectComponent.handler({ session: sessionId, component_id: 999 }),
      )?.error,
    ).toBe("react_component_not_found");
    expect(fake.sentCalls).toEqual([]);
  });
});

describe("React DevTools tools — detach and addressing", () => {
  it("unsubscribes, removes scripts/binding, clears events, and bumps generation", async () => {
    const { fake, session, sessionId } = setupSession();
    const attached = await attachReady(fake, session, sessionId);
    fake.clearSentCalls();

    const result = parseOkEnvelope<{
      status: string;
      generation: number;
    }>(await detach.handler({ session: sessionId }));

    expect(result.status).toBe("detached");
    expect(result.generation).toBeGreaterThan(attached.generation);
    expect(session.reactBridge).toBeNull();
    expect(session.reactEvents.size()).toBe(0);
    expect(fake.sentCalls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Runtime.removeBinding",
    ]);

    fake.clearSentCalls();
    expect(parseOkEnvelope(await detach.handler({ session: sessionId }))).toEqual({
      framework: "react",
      status: "not-attached",
      generation: result.generation,
    });
    expect(fake.sentCalls).toEqual([]);
  });

  it("performs the same bridge cleanup when the whole session closes", async () => {
    const { fake, session, sessionId } = setupSession();
    await attachReady(fake, session, sessionId);
    const cleanupMethods: string[] = [];
    for (const method of [
      "Runtime.evaluate",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Runtime.removeBinding",
    ]) {
      fake.onSend(method, () => cleanupMethods.push(method));
    }

    await registry.closeAddressed(sessionId);

    expect(cleanupMethods).toEqual([
      "Runtime.evaluate",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Runtime.removeBinding",
    ]);
    expect(session.reactBridge).toBeNull();
    expect(session.reactEvents.size()).toBe(0);
  });

  it("routes explicitly to the browser when a Node session is also live", async () => {
    const browser = setupSession({ kind: "browser", label: "frontend" });
    setupAdditionalSession({ kind: "node", label: "backend" });
    seedMainDocument(browser.session);
    readyOnReload(browser.fake, browser.session);

    const ambiguous = await attach.handler({ timeout_ms: 100 });
    expect(parseErrorEnvelope(ambiguous)?.error).toBe("ambiguous_session");

    const result = parseOkEnvelope<{ status: string }>(
      await attach.handler({ session: browser.sessionId, timeout_ms: 500 }),
    );
    expect(result.status).toBe("attached");

    seedMaterializedTree(browser.fake, browser.session);
    expect(parseErrorEnvelope(await getTree.handler({}))?.error).toBe(
      "ambiguous_session",
    );
    expect(
      parseOkEnvelope<{ total_nodes: number }>(
        await getTree.handler({ session: browser.sessionId }),
      ).total_nodes,
    ).toBe(5);
  });

  it("rejects all React tools on a Node session before making a CDP call", async () => {
    const { fake, sessionId } = setupSession({ kind: "node" });
    for (const [tool, args] of [
      [attach, { timeout_ms: 100 }],
      [getTree, {}],
      [findComponent, { name: "App" }],
      [inspectComponent, { component_id: 1 }],
      [detach, {}],
    ] as const) {
      const response = await tool.handler({ session: sessionId, ...args });
      expect(parseErrorEnvelope(response)).toMatchObject({
        error: "unsupported_target",
      });
    }
    expect(fake.sentCalls).toEqual([]);
  });
});
