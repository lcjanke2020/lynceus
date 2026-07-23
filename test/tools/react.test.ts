import { describe, expect, it, vi } from "vitest";
import { registerReactTools } from "../../src/tools/react.js";
import { registry, requireReactBridge } from "../../src/session/state.js";
import {
  REACT_BINDING_NAME,
  REACT_BRIDGE_SENTINEL_EVENT,
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
const detach = tools.get("detach_react_devtools")!;

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
  });

  it("rejects both tools on a Node session before making a CDP call", async () => {
    const { fake, sessionId } = setupSession({ kind: "node" });
    for (const tool of [attach, detach]) {
      const response = await tool.handler({ session: sessionId, timeout_ms: 100 });
      expect(parseErrorEnvelope(response)).toMatchObject({
        error: "unsupported_target",
      });
    }
    expect(fake.sentCalls).toEqual([]);
  });
});
