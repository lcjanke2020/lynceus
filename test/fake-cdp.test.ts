// Self-test for the L2 fake CDP. If this file goes red, every L2 tool test
// is suspect — the fake is the foundation everything else stands on.

import { describe, it, expect } from "vitest";
import { makeFakeCdp } from "./fake-cdp.js";

describe("makeFakeCdp — send + responders", () => {
  it("send() returns sensible defaults for the 'enable' chain", async () => {
    const fake = makeFakeCdp();
    expect(await fake.Runtime.enable()).toBeUndefined();
    expect(await fake.Debugger.enable({})).toEqual({ debuggerId: "fake-debugger" });
    expect(await fake.Page.enable()).toBeUndefined();
    expect(await fake.DOM.enable({})).toBeUndefined();
    expect(await fake.Network.enable({})).toBeUndefined();
  });

  it("send() throws fail-fast on unknown methods (was {} fallback in earlier rev — Codex PR #10 round-2 Med)", async () => {
    const fake = makeFakeCdp();
    await expect(fake.send("Some.UnregisteredMethod")).rejects.toThrow(
      /Fake CDP: no responder registered for 'Some.UnregisteredMethod'/,
    );
  });

  it("send() returns undefined for KNOWN_VOID_METHODS without a registered responder", async () => {
    const fake = makeFakeCdp();
    // Page.reload is in the allowlist; production legitimately calls it
    // and ignores the response.
    expect(await fake.send("Page.reload")).toBeUndefined();
  });

  it("respond() overrides the default for a method", async () => {
    const fake = makeFakeCdp();
    fake.respond("Runtime.evaluate", () => ({ result: { type: "string", value: "hi" } }));
    const r = await fake.Runtime.evaluate({ expression: "'hi'" });
    expect(r.result.value).toBe("hi");
  });

  it("respond() handlers receive (params, sessionId)", async () => {
    const fake = makeFakeCdp();
    let sawParams: any = null;
    let sawSession: any = null;
    fake.respond("Debugger.setBreakpointByUrl", (params, sessionId) => {
      sawParams = params;
      sawSession = sessionId;
      return { breakpointId: "ok", locations: [] };
    });
    await fake.Debugger.setBreakpointByUrl({ url: "x", lineNumber: 5 }, "SW1");
    expect(sawParams).toEqual({ url: "x", lineNumber: 5 });
    expect(sawSession).toBe("SW1");
  });

  it("default Debugger.setBreakpointByUrl mints a deterministic breakpointId", async () => {
    const fake = makeFakeCdp();
    const r = await fake.Debugger.setBreakpointByUrl({
      url: "http://x/foo.js",
      lineNumber: 10,
      columnNumber: 4,
    });
    expect(r.breakpointId).toBe("bp:http://x/foo.js:10:4");
    expect(r.locations).toHaveLength(1);
  });

  it("default Page.captureScreenshot returns a real PNG header", async () => {
    const fake = makeFakeCdp();
    const r = await fake.Page.captureScreenshot({});
    // PNG magic in base64 starts with "iVBOR"; the L2 screenshot test
    // asserts on this prefix so the default has to be valid.
    expect(r.data.startsWith("iVBOR")).toBe(true);
  });

  it("sentCalls records every send in order with the right session", async () => {
    const fake = makeFakeCdp();
    // Custom.Thing isn't in KNOWN_VOID_METHODS — register a responder to
    // avoid the fail-fast (which is exactly what Codex's round-2 Med made
    // unmodeled methods do).
    fake.respond("Custom.Thing", () => ({}));
    await fake.Runtime.enable();
    await fake.Debugger.enable({}, "SW1");
    await fake.send("Custom.Thing", { foo: 1 });
    expect(fake.sentCalls).toEqual([
      { method: "Runtime.enable", params: undefined, sessionId: undefined },
      { method: "Debugger.enable", params: {}, sessionId: "SW1" },
      { method: "Custom.Thing", params: { foo: 1 }, sessionId: undefined },
    ]);
  });

  it("clearSentCalls() empties the log without affecting responders", async () => {
    const fake = makeFakeCdp();
    await fake.Runtime.enable();
    fake.clearSentCalls();
    expect(fake.sentCalls).toHaveLength(0);
    // Defaults still work after clearing.
    expect(await fake.Debugger.enable({})).toEqual({ debuggerId: "fake-debugger" });
  });
});

describe("makeFakeCdp — onSend hooks (auto-attach replay invariant)", () => {
  it("hook fires synchronously BEFORE the send promise resolves", async () => {
    // This is the load-bearing property: production registers
    // Target.attachedToTarget BEFORE awaiting setAutoAttach. The hook must
    // fire its emit() synchronously so the production handler runs before
    // the await resumes — exactly mirroring Chrome's inline batch.
    const fake = makeFakeCdp();
    const events: string[] = [];

    // Production-side: subscribe before the await.
    fake.on("Target.attachedToTarget", () => events.push("handler-ran"));

    // Test-side: register a hook that fires the event when setAutoAttach is called.
    fake.onSend("Target.setAutoAttach", () => {
      fake.fireEvent(
        "Target.attachedToTarget",
        { sessionId: "child-1", targetInfo: { type: "worker", url: "ws://x", targetId: "t1" } },
        undefined,
      );
    });

    // Production: await setAutoAttach.
    await fake.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    events.push("after-await");

    // The handler MUST have run before the await resumed.
    expect(events).toEqual(["handler-ran", "after-await"]);
  });

  it("multiple hooks for the same method all fire", async () => {
    const fake = makeFakeCdp();
    fake.respond("Custom.Method", () => ({})); // unknown method — avoid fail-fast
    let count = 0;
    fake.onSend("Custom.Method", () => count++);
    fake.onSend("Custom.Method", () => count++);
    await fake.send("Custom.Method", {});
    expect(count).toBe(2);
  });

  it("hooks for one method don't fire on a different method", async () => {
    const fake = makeFakeCdp();
    fake.respond("A.x", () => ({}));
    fake.respond("B.y", () => ({}));
    let fired = false;
    fake.onSend("A.x", () => { fired = true; });
    await fake.send("B.y", {});
    expect(fired).toBe(false);
  });
});

describe("makeFakeCdp — fireEvent (flatten:true two-arg shape)", () => {
  it("emits with sessionId as a SECOND argument", async () => {
    const fake = makeFakeCdp();
    let captured: { params: any; sessionId?: string } | null = null;
    fake.on("Debugger.paused", (params: any, sessionId?: string) => {
      captured = { params, sessionId };
    });
    fake.fireEvent("Debugger.paused", { reason: "breakpoint" }, "SW1");
    expect(captured).toEqual({ params: { reason: "breakpoint" }, sessionId: "SW1" });
  });

  it("for root events, the second arg is undefined (NOT omitted)", async () => {
    // Critical: production guards `eventSessionId === sessionId`. If the
    // fake omitted the second arg for root events, eventSessionId would
    // also be undefined — which happens to equal sessionId=undefined for
    // the root handler. But subtle: a handler registered with .length=2
    // distinguishes "called with one arg" from "called with two args
    // where the second is undefined". The fake uses emit(event, params,
    // undefined) for root, matching real Chrome.
    const fake = makeFakeCdp();
    const args: any[] = [];
    fake.on("Debugger.resumed", (...a: any[]) => args.push(a));
    fake.fireEvent("Debugger.resumed", {}, undefined);
    expect(args).toHaveLength(1);
    expect(args[0]).toHaveLength(2); // (params, sessionId=undefined)
    expect(args[0][1]).toBeUndefined();
  });
});

describe("makeFakeCdp — seedScript", () => {
  it("emits Debugger.scriptParsed with the production-expected fields", () => {
    const fake = makeFakeCdp();
    let captured: any = null;
    let capturedSession: any = null;
    fake.on("Debugger.scriptParsed", (params: any, sessionId?: string) => {
      captured = params;
      capturedSession = sessionId;
    });
    fake.seedScript({ scriptId: "s42", url: "http://x/app.js", sourceMapURL: "app.js.map", sessionId: "SW1" });
    expect(captured).toMatchObject({
      scriptId: "s42",
      url: "http://x/app.js",
      sourceMapURL: "app.js.map",
      executionContextId: 1,
      hash: "fake-hash",
      isModule: false,
    });
    expect(capturedSession).toBe("SW1");
  });

  it("defaults sourceMapURL to '' so attachScriptListener skips map loading", () => {
    const fake = makeFakeCdp();
    let captured: any = null;
    fake.on("Debugger.scriptParsed", (params: any) => { captured = params; });
    fake.seedScript({ scriptId: "s1", url: "http://x/raw.js" });
    expect(captured.sourceMapURL).toBe("");
  });
});

describe("makeFakeCdp — fireNetworkLifecycle", () => {
  it("emits requestWillBeSent → responseReceived → loadingFinished in order", () => {
    const fake = makeFakeCdp();
    const order: string[] = [];
    fake.on("Network.requestWillBeSent", () => order.push("req"));
    fake.on("Network.responseReceived", () => order.push("res"));
    fake.on("Network.loadingFinished", () => order.push("done"));
    fake.on("Network.loadingFailed", () => order.push("fail"));
    fake.fireNetworkLifecycle("r1", { url: "http://x/a", status: 200 });
    expect(order).toEqual(["req", "res", "done"]);
  });

  it("failed: true emits requestWillBeSent → loadingFailed (no responseReceived)", () => {
    const fake = makeFakeCdp();
    const order: string[] = [];
    fake.on("Network.requestWillBeSent", () => order.push("req"));
    fake.on("Network.responseReceived", () => order.push("res"));
    fake.on("Network.loadingFinished", () => order.push("done"));
    fake.on("Network.loadingFailed", () => order.push("fail"));
    fake.fireNetworkLifecycle("r2", { failed: true, errorText: "net::ERR_NAME_NOT_RESOLVED" });
    expect(order).toEqual(["req", "fail"]);
  });

  it("propagates the sessionId through every event in the chain", () => {
    const fake = makeFakeCdp();
    const sessions: any[] = [];
    for (const ev of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished"]) {
      fake.on(ev, (_p: any, sid?: string) => sessions.push(sid));
    }
    fake.fireNetworkLifecycle("r3", { sessionId: "IF1" });
    expect(sessions).toEqual(["IF1", "IF1", "IF1"]);
  });

  it("requestWillBeSent carries url+method+type that production reads", () => {
    const fake = makeFakeCdp();
    let captured: any = null;
    fake.on("Network.requestWillBeSent", (p: any) => { captured = p; });
    fake.fireNetworkLifecycle("r4", { url: "http://x/y", method: "POST", type: "Fetch" });
    expect(captured.request.url).toBe("http://x/y");
    expect(captured.request.method).toBe("POST");
    expect(captured.type).toBe("Fetch");
  });

  it("responseReceived carries status/statusText/mimeType/fromCache flags", () => {
    const fake = makeFakeCdp();
    let captured: any = null;
    fake.on("Network.responseReceived", (p: any) => { captured = p; });
    fake.fireNetworkLifecycle("r5", { status: 404, statusText: "Not Found", mimeType: "text/html", fromCache: true });
    expect(captured.response).toMatchObject({
      status: 404,
      statusText: "Not Found",
      mimeType: "text/html",
      fromDiskCache: true,
    });
  });
});

describe("makeFakeCdp — makePauseState", () => {
  it("returns a paused state with one frame and local+global scopes by default", () => {
    const fake = makeFakeCdp();
    const s = fake.makePauseState();
    expect(s.reason).toBe("breakpoint");
    expect(s.callFrames).toHaveLength(1);
    expect(s.callFrames[0]?.scopeChain.map((sc) => sc.type)).toEqual(["local", "global"]);
    // objectId is counter-seeded (rev-2 fold of Opus PR #10 Nit on
    // multi-pause collisions): match shape rather than literal "scope-local-0".
    expect(s.callFrames[0]?.scopeChain[0]?.object.objectId).toMatch(/^scope-local-\d+$/);
  });

  it("counter-seed: back-to-back makePauseState() calls produce non-colliding objectIds", () => {
    const fake = makeFakeCdp();
    const a = fake.makePauseState();
    const b = fake.makePauseState();
    const idA = a.callFrames[0]?.scopeChain[0]?.object.objectId;
    const idB = b.callFrames[0]?.scopeChain[0]?.object.objectId;
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^scope-local-\d+$/);
    expect(idB).toMatch(/^scope-local-\d+$/);
  });

  it("respects opts.reason / opts.hitBreakpoints / opts.sessionId", () => {
    const fake = makeFakeCdp();
    const s = fake.makePauseState({ reason: "exception", hitBreakpoints: ["bp:1"], sessionId: "SW1" });
    expect(s.reason).toBe("exception");
    expect(s.hitBreakpoints).toEqual(["bp:1"]);
    expect(s.sessionId).toBe("SW1");
  });

  it("opts.callFrames overrides the default frame", () => {
    const fake = makeFakeCdp();
    const customFrames: any = [
      { callFrameId: "f0", functionName: "main", location: { scriptId: "s1", lineNumber: 0, columnNumber: 0 }, scopeChain: [] },
      { callFrameId: "f1", functionName: "init", location: { scriptId: "s1", lineNumber: 5, columnNumber: 2 }, scopeChain: [] },
    ];
    const s = fake.makePauseState({ callFrames: customFrames });
    expect(s.callFrames).toHaveLength(2);
    expect(s.callFrames.map((f) => f.functionName)).toEqual(["main", "init"]);
  });
});

describe("makeFakeCdp — close()", () => {
  it("removes all listeners so the fake can be safely re-used after close", async () => {
    const fake = makeFakeCdp();
    let count = 0;
    fake.on("Debugger.paused", () => count++);
    await fake.close();
    fake.fireEvent("Debugger.paused", { reason: "breakpoint" });
    expect(count).toBe(0);
  });
});
