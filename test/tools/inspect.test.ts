import { describe, it, expect } from "vitest";
import { sessionState } from "../../src/session/state.js";
import { registerInspectTools } from "../../src/tools/inspect.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerInspectTools);
const stack = tools.get("get_call_stack")!;
const scope = tools.get("get_scope")!;
const evaluate = tools.get("evaluate")!;
const getProps = tools.get("get_object_properties")!;

describe("get_call_stack", () => {
  it("not_paused error", async () => {
    setupSession();
    expect(parseErrorEnvelope(await stack.handler({}))?.error).toBe("not_paused");
  });

  it("returns one frame per call frame with TS-mapped fields when no source map exists", async () => {
    // No script in store → mappedFile is null, falls back to script URL or "<unknown>".
    setupSession({ paused: true });
    const r = parseOkEnvelope<any[]>(await stack.handler({}));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      index: 0,
      function_name: "computeStep",
      file: "http://localhost/handlers.js", // fall back to cf.url
      session_id: null,
    });
    // scope_types are extracted from the frame's scopeChain.
    expect(r[0].scope_types).toEqual(["local", "global"]);
  });

  it("emits session_id of the paused session for routing follow-on calls", async () => {
    setupSession({ paused: true, pausedSessionId: "SW1" });
    const r = parseOkEnvelope<any[]>(await stack.handler({}));
    expect(r[0].session_id).toBe("SW1");
  });
});

describe("get_scope", () => {
  it("not_paused error", async () => {
    setupSession();
    expect(parseErrorEnvelope(await scope.handler({}))?.error).toBe("not_paused");
  });

  it("bad_frame error when frame_index is out of range", async () => {
    setupSession({ paused: true });
    const err = parseErrorEnvelope(await scope.handler({ frame_index: 99 }));
    expect(err?.error).toBe("bad_frame");
    expect(err?.message).toContain("99");
    expect(err?.message).toContain("1 frames");
  });

  it("no_scope error when the frame has no scope of the requested type", async () => {
    setupSession({ paused: true });
    // Default frame has 'local' and 'global' scopes only.
    const err = parseErrorEnvelope(await scope.handler({ scope_type: "closure" }));
    expect(err?.error).toBe("no_scope");
    expect(err?.message).toContain("closure");
    expect(err?.message).toContain("local");
  });

  it("happy path: returns the frame's local-scope properties and the paused session_id", async () => {
    const { fake } = setupSession({ paused: true });
    fake.respond("Runtime.getProperties", () => ({
      result: [
        { name: "count", value: { type: "number", value: 7 }, writable: true, enumerable: true },
        { name: "step", value: { type: "number", value: 2 }, writable: true, enumerable: true },
      ],
    }));
    const r = parseOkEnvelope<{ items: any[]; scope_type: string; session_id: string | null }>(
      await scope.handler({}),
    );
    expect(r.scope_type).toBe("local");
    expect(r.items.map((i) => [i.name, i.preview])).toEqual([
      ["count", "7"],
      ["step", "2"],
    ]);
    expect(r.session_id).toBeNull();
  });

  it("session_id flows into the Runtime.getProperties send for child sessions", async () => {
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    fake.clearSentCalls();
    await scope.handler({});
    const call = fake.sentCalls.find((c) => c.method === "Runtime.getProperties");
    expect(call?.sessionId).toBe("SW1");
  });

  it("max_props caps the returned items and sets truncated:true", async () => {
    const { fake } = setupSession({ paused: true });
    fake.respond("Runtime.getProperties", () => ({
      result: Array.from({ length: 100 }, (_, i) => ({
        name: `p${i}`,
        value: { type: "number", value: i },
      })),
    }));
    const r = parseOkEnvelope<{ items: any[]; truncated: boolean }>(
      await scope.handler({ max_props: 5 }),
    );
    expect(r.items).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });

  // Regression cover for LEO-399 / GH #42: a `for (let i…)` loop variable is
  // block-scoped, so a single-scope read of `local` never surfaces it. The
  // default (no scope_type) call must merge the innermost lexical scopes.
  const blockLocalFrame = () =>
    [
      {
        callFrameId: "frame-blk-0",
        functionName: "main",
        functionLocation: { scriptId: "s1", lineNumber: 0, columnNumber: 0 },
        location: { scriptId: "s1", lineNumber: 15, columnNumber: 8 },
        url: "http://localhost/conditional-bp.js",
        scopeChain: [
          { type: "block", object: { type: "object", className: "Object", description: "Object", objectId: "scope-block" } },
          { type: "local", object: { type: "object", className: "Object", description: "Object", objectId: "scope-local" } },
          { type: "global", object: { type: "object", className: "Window", description: "Window", objectId: "scope-global" } },
        ],
        this: { type: "object", className: "global", description: "global", objectId: "this-0" },
      },
    ] as any;

  it("default (no scope_type) merges block + local so block-scoped vars surface; innermost wins", async () => {
    const { fake } = setupSession();
    sessionState.pause.onPaused(fake.makePauseState({ callFrames: blockLocalFrame() }));
    fake.respond("Runtime.getProperties", (params: any) => {
      if (params.objectId === "scope-block")
        return {
          result: [
            { name: "i", value: { type: "number", value: 3 }, writable: true, enumerable: true },
            { name: "shadow", value: { type: "number", value: 1 }, writable: true, enumerable: true },
          ],
        };
      if (params.objectId === "scope-local")
        return {
          result: [
            { name: "v", value: { type: "number", value: 30 }, writable: true, enumerable: true },
            { name: "shadow", value: { type: "number", value: 99 }, writable: true, enumerable: true },
          ],
        };
      return { result: [] };
    });
    fake.clearSentCalls();
    const r = parseOkEnvelope<{
      scope_type: string;
      merged_scope_types: string[];
      items: Array<{ name: string; preview: string }>;
    }>(await scope.handler({}));

    expect(r.scope_type).toBe("local");
    expect(r.merged_scope_types).toEqual(["block", "local"]);
    // Both the block-scoped `i` and the function-local `v` are present.
    expect(r.items.find((i) => i.name === "i")?.preview).toBe("3");
    expect(r.items.find((i) => i.name === "v")?.preview).toBe("30");
    // Shadowing: the inner (block) binding wins → one `shadow`, value 1.
    const shadows = r.items.filter((i) => i.name === "shadow");
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.preview).toBe("1");
    // The default merge stops at the first non-lexical scope: global is NOT read.
    expect(
      fake.sentCalls.filter((c) => c.method === "Runtime.getProperties").map((c) => c.params.objectId),
    ).toEqual(["scope-block", "scope-local"]);
  });

  it("explicit scope_type reads exactly one scope (single-scope path unchanged)", async () => {
    const { fake } = setupSession();
    sessionState.pause.onPaused(fake.makePauseState({ callFrames: blockLocalFrame() }));
    fake.respond("Runtime.getProperties", (params: any) => {
      if (params.objectId === "scope-block")
        return { result: [{ name: "i", value: { type: "number", value: 3 } }] };
      if (params.objectId === "scope-local")
        return { result: [{ name: "v", value: { type: "number", value: 30 } }] };
      return { result: [] };
    });
    const r = parseOkEnvelope<{ scope_type: string; merged_scope_types?: string[]; items: Array<{ name: string }> }>(
      await scope.handler({ scope_type: "block" }),
    );
    expect(r.scope_type).toBe("block");
    expect(r.merged_scope_types).toBeUndefined();
    expect(r.items.map((i) => i.name)).toEqual(["i"]);
  });

  it("merged default short-circuits: stops fetching outer scopes once max_props is exceeded", async () => {
    const { fake } = setupSession();
    sessionState.pause.onPaused(fake.makePauseState({ callFrames: blockLocalFrame() }));
    fake.respond("Runtime.getProperties", (params: any) => {
      if (params.objectId === "scope-block")
        return { result: Array.from({ length: 60 }, (_, n) => ({ name: `b${n}`, value: { type: "number", value: n } })) };
      // If the merge reaches `local` it would blow up the assertion below.
      if (params.objectId === "scope-local")
        return { result: [{ name: "v", value: { type: "number", value: 30 } }] };
      return { result: [] };
    });
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ items: any[]; truncated: boolean }>(await scope.handler({})); // default max 50
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
    // The inner block already exceeds max, so `local` is never fetched.
    expect(
      fake.sentCalls.filter((c) => c.method === "Runtime.getProperties").map((c) => c.params.objectId),
    ).toEqual(["scope-block"]);
  });
});

describe("evaluate", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await evaluate.handler({ expression: "1" }))?.error).toBe("no_session");
  });

  it("frame_index requires paused state", async () => {
    setupSession();
    const err = parseErrorEnvelope(await evaluate.handler({ expression: "x", frame_index: 0 }));
    expect(err?.error).toBe("not_paused");
  });

  it("frame_index out of range → bad_frame", async () => {
    setupSession({ paused: true });
    const err = parseErrorEnvelope(await evaluate.handler({ expression: "x", frame_index: 5 }));
    expect(err?.error).toBe("bad_frame");
  });

  it("page-context evaluation: uses Runtime.evaluate and returns session_id:null", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "number", value: 42 },
    }));
    const r = parseOkEnvelope<{ type: string; preview: string; value: any; session_id: string | null }>(
      await evaluate.handler({ expression: "40 + 2" }),
    );
    expect(r.type).toBe("number");
    expect(r.value).toBe(42);
    expect(r.session_id).toBeNull();
  });

  it("frame-context evaluation: uses Debugger.evaluateOnCallFrame routed to the paused session", async () => {
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.respond("Debugger.evaluateOnCallFrame", () => ({
      result: { type: "string", value: "hi" },
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ value: any; session_id: string | null }>(
      await evaluate.handler({ expression: "foo()", frame_index: 0 }),
    );
    expect(r.value).toBe("hi");
    expect(r.session_id).toBe("SW1");
    const call = fake.sentCalls.find((c) => c.method === "Debugger.evaluateOnCallFrame");
    expect(call?.sessionId).toBe("SW1");
    // callFrameId is now counter-seeded (rev-2 fold of Opus PR #10 Nit
     // on multi-pause collisions): match shape rather than literal "frame-0".
    expect(call?.params.callFrameId).toMatch(/^frame-\d+-0$/);
  });

  it("auto-falls-back to Debugger.evaluateOnCallFrame on top frame when paused with no frame_index (issue #72)", async () => {
    // Regression: previously, omitting frame_index while paused routed to
    // Runtime.evaluate, which blocks on the frozen V8 event loop and times
    // out after ~30s. Auto-detect paused state and pick the right CDP call.
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.respond("Debugger.evaluateOnCallFrame", () => ({
      result: { type: "object", subtype: "node" },
    }));
    fake.respond("Runtime.evaluate", () => {
      throw new Error("Runtime.evaluate must NOT be called while paused");
    });
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ type: string; session_id: string | null }>(
      await evaluate.handler({ expression: "document.querySelectorAll('.x')" }),
    );
    expect(r.type).toBe("node");
    expect(r.session_id).toBe("SW1");
    const call = fake.sentCalls.find((c) => c.method === "Debugger.evaluateOnCallFrame");
    expect(call?.sessionId).toBe("SW1");
    expect(call?.params.callFrameId).toMatch(/^frame-\d+-0$/);
    // Pins the description-only contract that DEoCF never sees awaitPromise.
    // CDP doesn't support it on this method, and while paused no Promise
    // could resolve anyway — adding it "for symmetry" with Runtime.evaluate
    // would type-check, leave the tests passing, and silently break the
    // documented "Promise returned unresolved" behavior.
    expect(call?.params.awaitPromise).toBeUndefined();
    expect(fake.sentCalls.find((c) => c.method === "Runtime.evaluate")).toBeUndefined();
  });

  it("evaluation exception surfaces in the result envelope (not a thrown ToolError)", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", subtype: "error" },
      exceptionDetails: {
        text: "Uncaught ReferenceError",
        exception: { type: "object", description: "ReferenceError: x is not defined" },
      },
    }));
    const r = parseOkEnvelope<{ error: boolean; message: string }>(
      await evaluate.handler({ expression: "x" }),
    );
    expect(r.error).toBe(true);
    expect(r.message).toContain("ReferenceError");
  });
});

describe("get_object_properties", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getProps.handler({ object_id: "obj1" }))?.error).toBe("no_session");
  });

  it("strict session routing: omitted session_id sends sessionId=undefined to CDP", async () => {
    // Documented at src/tools/inspect.ts:164. The previous "fall back to
    // paused session" misrouted root-minted objectIds.
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    fake.clearSentCalls();
    await getProps.handler({ object_id: "obj1" }); // no session_id passed
    const call = fake.sentCalls.find((c) => c.method === "Runtime.getProperties");
    expect(call?.sessionId).toBeUndefined();
  });

  it("explicit null session_id is treated as root", async () => {
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    fake.clearSentCalls();
    await getProps.handler({ object_id: "obj1", session_id: null });
    expect(fake.sentCalls.find((c) => c.method === "Runtime.getProperties")?.sessionId).toBeUndefined();
  });

  it("explicit string session_id routes to that child session", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    fake.clearSentCalls();
    await getProps.handler({ object_id: "obj1", session_id: "IF1" });
    expect(fake.sentCalls.find((c) => c.method === "Runtime.getProperties")?.sessionId).toBe("IF1");
  });

  it("emits session_id on the response envelope for round-trip safety", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    const rRoot = parseOkEnvelope<{ session_id: string | null }>(
      await getProps.handler({ object_id: "x" }),
    );
    expect(rRoot.session_id).toBeNull();
    const rChild = parseOkEnvelope<{ session_id: string | null }>(
      await getProps.handler({ object_id: "x", session_id: "SW1" }),
    );
    expect(rChild.session_id).toBe("SW1");
  });

  it("own_only forwards as ownProperties to CDP (default true)", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.getProperties", () => ({ result: [] }));
    fake.clearSentCalls();
    await getProps.handler({ object_id: "x" });
    expect(fake.sentCalls[0]?.params.ownProperties).toBe(true);
    fake.clearSentCalls();
    await getProps.handler({ object_id: "x", own_only: false });
    expect(fake.sentCalls[0]?.params.ownProperties).toBe(false);
  });
});

describe("registration metadata", () => {
  it("registers exactly the four inspect tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "evaluate",
      "get_call_stack",
      "get_object_properties",
      "get_scope",
    ]);
  });
});
