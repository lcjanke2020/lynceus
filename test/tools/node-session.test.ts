// Node L2 contract tests. Parity coverage for the debugger-flow
// tools when sessionState.kind === "node". The browser-mode tests already
// cover full surface semantics; this file's job is to pin that the same
// surface keeps working when an agent is attached to a Node Inspector target
// instead of a Chromium page.
//
// Bullets NOT re-covered here (already exhaustive elsewhere):
//   * attach_node happy path + already-active-session rejection
//       → test/tools/session.test.ts:280–389
//   * Node domain enablement (no Page/DOM/browser Network; runIfWaitingForDebugger ordering)
//       → same file
//   * Browser-only tools return `unsupported_target` (15-tool matrix)
//       → test/tools/capabilities.test.ts
//   * Source-map loader filesystem / file:// tier
//       → src/sourcemap/loader.test.ts:49–224
//
// What IS covered here: list_scripts on file:// URLs, set_breakpoint binding
// through file:// URL → setBreakpointByUrl on a Node session, step/resume
// routing on a Node session, get_scope + get_object_properties + evaluate
// parity (including the paused-fallback path with a Node-shaped
// pause where sessionId is undefined — Node attach is single-target, so the
// real-world pause has no eventSessionId).
//
// Note on call-stack source-mapping: summarizePause awaits the
// loadSourceMap consumer for each frame (source-map wait race 2) by polling
// scripts.hasPendingMaps(). On a fresh setupSession with no pending loads,
// the predicate short-circuits immediately, so wait_for_pause / step_over
// resolve without burning the 500ms MAP_LOAD_WAIT_MS deadline.

import { describe, it, expect } from "vitest";
import { sessionState } from "../../src/session/state.js";
import { registerSourceTools } from "../../src/tools/source.js";
import { registerBreakpointTools } from "../../src/tools/breakpoints.js";
import { registerExecutionTools } from "../../src/tools/execution.js";
import { registerInspectTools } from "../../src/tools/inspect.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseOkEnvelope } from "../handler-registry.js";
import { seedMappedScript } from "../helpers/source-maps.js";

autoReset();

const sourceTools = captureTools(registerSourceTools);
const breakpointTools = captureTools(registerBreakpointTools);
const executionTools = captureTools(registerExecutionTools);
const inspectTools = captureTools(registerInspectTools);

const listScripts = sourceTools.get("list_scripts")!;
const setBp = breakpointTools.get("set_breakpoint")!;
const removeBp = breakpointTools.get("remove_breakpoint")!;
const listBp = breakpointTools.get("list_breakpoints")!;
const resume = executionTools.get("resume")!;
const stepOver = executionTools.get("step_over")!;
const waitForPause = executionTools.get("wait_for_pause")!;
const getScope = inspectTools.get("get_scope")!;
const evaluate = inspectTools.get("evaluate")!;
const getObjectProperties = inspectTools.get("get_object_properties")!;

describe("Node session: script discovery", () => {
  it("list_scripts returns Node file:// URLs with session_id:null (root) and has_map:true once a map is attached", async () => {
    setupSession({ kind: "node" });
    seedMappedScript({
      scriptId: "node-s1",
      url: "file:///app/dist/handlers.js",
      source: "src/handlers.ts",
      tsLine: 2,
      jsLine: 1,
    });
    const r = parseOkEnvelope<
      Array<{ script_id: string; url: string; session_id: string | null; has_map: boolean }>
    >(await listScripts.handler({}));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      script_id: "node-s1",
      url: "file:///app/dist/handlers.js",
      // Node attach is a single root debug session — no child sessionId.
      session_id: null,
      has_map: true,
    });
  });

  it("mapped_only:false surfaces a Node script that has NOT loaded a source map yet", async () => {
    // Mirrors the realistic 'just scriptParsed, no sourceMappingURL or
    // map not yet loaded' state on a Node session.
    setupSession({ kind: "node" });
    sessionState.scripts.upsert({
      scriptId: "node-raw",
      url: "file:///app/dist/no-map.js",
      startLine: 0,
      startColumn: 0,
      endLine: 1,
      endColumn: 0,
      executionContextId: 1,
      hash: "h",
    });
    const onlyMapped = parseOkEnvelope<any[]>(await listScripts.handler({}));
    expect(onlyMapped).toEqual([]);
    const all = parseOkEnvelope<any[]>(await listScripts.handler({ mapped_only: false }));
    expect(all.map((s) => s.script_id)).toEqual(["node-raw"]);
    expect(all[0].has_map).toBe(false);
  });
});

describe("Node session: set_breakpoint on file:// URLs", () => {
  it("binds a TS breakpoint through to Debugger.setBreakpointByUrl with the file:// generated URL", async () => {
    const { fake } = setupSession({ kind: "node" });
    seedMappedScript({
      scriptId: "node-s1",
      url: "file:///app/dist/handlers.js",
      source: "src/handlers.ts",
      tsLine: 2,
      jsLine: 1,
    });
    // Custom responder echoing the seeded scriptId so the post-CDP
    // mapCdpToOriginal call resolves the response location back to the TS
    // coord. The fake's default responder hardcodes "fake-script-id",
    // which would fall through to the JS-URL fallback in
    // src/tools/breakpoints.ts:96. Same pattern as breakpoints.test.ts:35.
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "node-s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{
      id: string;
      binding_count: number;
      resolved_locations: Array<{ file: string; line: number; column: number }>;
      status: "set" | "already-set";
    }>(await setBp.handler({ file: "src/handlers.ts", line: 2 }));
    expect(r.status).toBe("set");
    expect(r.binding_count).toBe(1);
    expect(r.resolved_locations[0]).toEqual({ file: "src/handlers.ts", line: 2, column: 0 });
    // setBreakpointByUrl carries the file:// generated URL (not a regex,
    // not the TS path) — the production contract from
    // src/tools/breakpoints.ts:85 must hold on Node URLs too.
    const call = fake.sentCalls.find((c) => c.method === "Debugger.setBreakpointByUrl");
    expect(call?.params.url).toBe("file:///app/dist/handlers.js");
    expect(call?.params.urlRegex).toBeUndefined();
    // Node attach has no child sessions, so the binding sessionId is undefined.
    expect(call?.sessionId).toBeUndefined();
  });

  it("remove_breakpoint + list_breakpoints round-trip on a Node session", async () => {
    const { fake } = setupSession({ kind: "node" });
    seedMappedScript({
      scriptId: "node-s1",
      url: "file:///app/dist/handlers.js",
      source: "src/handlers.ts",
      tsLine: 2,
      jsLine: 1,
    });
    const set = parseOkEnvelope<{ id: string }>(
      await setBp.handler({ file: "src/handlers.ts", line: 2 }),
    );
    expect(parseOkEnvelope<any[]>(await listBp.handler({}))).toHaveLength(1);
    fake.clearSentCalls();
    expect(parseOkEnvelope(await removeBp.handler({ id: set.id }))).toBe("removed");
    expect(parseOkEnvelope<any[]>(await listBp.handler({}))).toEqual([]);
    expect(fake.sentCalls.find((c) => c.method === "Debugger.removeBreakpoint")).toBeDefined();
  });
});

describe("Node session: pause / step / resume parity", () => {
  it("wait_for_pause returns the call stack on a Node session (pausedSessionId undefined)", async () => {
    // Node attach: pause has no eventSessionId. session_id round-trips as null.
    setupSession({ kind: "node", paused: true });
    const r = parseOkEnvelope<{ reason: string; session_id: string | null; call_stack: any[] }>(
      await waitForPause.handler({ timeout_ms: 100 }),
    );
    expect(r.reason).toBe("breakpoint");
    expect(r.session_id).toBeNull();
    expect(r.call_stack).toHaveLength(1);
    expect(r.call_stack[0].session_id).toBeNull();
  });

  it("step_over fires Debugger.stepOver with sessionId undefined on a Node root pause", async () => {
    const { fake } = setupSession({ kind: "node", paused: true });
    fake.clearSentCalls();
    // Mirror execution.test.ts:128 'same-batch pause' shape: emit the next
    // Debugger.paused synchronously inside the stepOver responder so
    // waitForPauseOrResume resolves before its timeout.
    fake.onSend("Debugger.stepOver", () => {
      sessionState.pause.onPaused(fake.makePauseState({ reason: "step", sessionId: undefined }));
    });
    const r = parseOkEnvelope<{ paused: boolean; reason: string; session_id: string | null }>(
      await stepOver.handler({ timeout_ms: 50 }),
    );
    expect(r.paused).toBe(true);
    expect(r.reason).toBe("step");
    expect(r.session_id).toBeNull();
    const call = fake.sentCalls.find((c) => c.method === "Debugger.stepOver");
    expect(call?.sessionId).toBeUndefined();
  });

  it("resume drains the pause state on a Node session", async () => {
    const { fake } = setupSession({ kind: "node", paused: true });
    fake.clearSentCalls();
    fake.onSend("Debugger.resume", () => {
      sessionState.pause.onResumed();
    });
    expect(parseOkEnvelope(await resume.handler({}))).toBe("resumed");
    expect(sessionState.pause.isPaused()).toBe(false);
    const call = fake.sentCalls.find((c) => c.method === "Debugger.resume");
    expect(call?.sessionId).toBeUndefined();
  });
});

describe("Node session: frame inspection", () => {
  it("get_scope reads the local scope of the paused Node frame and round-trips session_id:null", async () => {
    const { fake } = setupSession({ kind: "node", paused: true });
    fake.respond("Runtime.getProperties", () => ({
      result: [
        { name: "n", value: { type: "number", value: 1 }, writable: true, enumerable: true },
      ],
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ items: any[]; session_id: string | null }>(
      await getScope.handler({}),
    );
    expect(r.session_id).toBeNull();
    expect(r.items.map((i) => i.name)).toEqual(["n"]);
    // Pin the wire-level routing too, not just the response envelope:
    // get_scope on a Node session must send Runtime.getProperties with
    // sessionId undefined (no child target). Mirrors the sibling
    // get_object_properties assertion below.
    const call = fake.sentCalls.find((c) => c.method === "Runtime.getProperties");
    expect(call?.sessionId).toBeUndefined();
  });

  it("get_object_properties on a Node session routes to root (sessionId undefined)", async () => {
    // get_object_properties does not require paused state — the tool
    // accepts a bare object_id and routes the Runtime.getProperties call.
    const { fake } = setupSession({ kind: "node" });
    fake.respond("Runtime.getProperties", () => ({
      result: [
        { name: "a", value: { type: "number", value: 42 }, writable: true, enumerable: true },
      ],
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ items: any[]; session_id: string | null }>(
      await getObjectProperties.handler({ object_id: "node-obj-1" }),
    );
    expect(r.session_id).toBeNull();
    expect(r.items[0]?.name).toBe("a");
    const call = fake.sentCalls.find((c) => c.method === "Runtime.getProperties");
    expect(call?.sessionId).toBeUndefined();
    expect(call?.params.objectId).toBe("node-obj-1");
  });
});

describe("Node session: evaluate paused-fallback", () => {
  it("paused on a Node session with no frame_index → routes to Debugger.evaluateOnCallFrame, NOT Runtime.evaluate", async () => {
    // The paused-fallback contract is that any paused state must
    // route evaluate through Debugger.evaluateOnCallFrame so the call
    // doesn't block on the frozen V8 event loop. Node sessions can pause
    // exactly the same way browsers can (debugger statement, breakpoint,
    // --inspect-brk entry pause), and the fallback must hold there too.
    // The browser-mode mirror lives at inspect.test.ts:159; this is the
    // Node-mode counterpart with sessionId undefined.
    const { fake } = setupSession({ kind: "node", paused: true });
    fake.respond("Debugger.evaluateOnCallFrame", () => ({
      result: { type: "number", value: 42 },
    }));
    fake.respond("Runtime.evaluate", () => {
      throw new Error("Runtime.evaluate must NOT be called while paused on a Node session");
    });
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ type: string; value: any; session_id: string | null }>(
      await evaluate.handler({ expression: "40 + 2" }),
    );
    expect(r.type).toBe("number");
    expect(r.value).toBe(42);
    expect(r.session_id).toBeNull();
    const call = fake.sentCalls.find((c) => c.method === "Debugger.evaluateOnCallFrame");
    expect(call?.sessionId).toBeUndefined();
    expect(call?.params.callFrameId).toMatch(/^frame-\d+-0$/);
    // Same belt-and-suspenders check as inspect.test.ts:184 — DEoCF on a
    // paused Node session must not carry awaitPromise (CDP rejects it).
    expect(call?.params.awaitPromise).toBeUndefined();
    expect(fake.sentCalls.find((c) => c.method === "Runtime.evaluate")).toBeUndefined();
  });

  it("not paused on a Node session → falls back to Runtime.evaluate", async () => {
    const { fake } = setupSession({ kind: "node" });
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "number", value: 7 },
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ value: any; session_id: string | null }>(
      await evaluate.handler({ expression: "3 + 4" }),
    );
    expect(r.value).toBe(7);
    expect(r.session_id).toBeNull();
    expect(fake.sentCalls.find((c) => c.method === "Runtime.evaluate")).toBeDefined();
    expect(fake.sentCalls.find((c) => c.method === "Debugger.evaluateOnCallFrame")).toBeUndefined();
  });
});
