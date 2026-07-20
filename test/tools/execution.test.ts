import { describe, it, expect } from "vitest";
import { registry } from "../../src/session/state.js";
import { registerExecutionTools } from "../../src/tools/execution.js";
import { RACED_WAIT_SESSION_DESC } from "../../src/tools/_session_input.js";
import { setupSession, setupAdditionalSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerExecutionTools);
const resume = tools.get("resume")!;
const stepOver = tools.get("step_over")!;
const stepInto = tools.get("step_into")!;
const stepOut = tools.get("step_out")!;
const pause = tools.get("pause")!;
const waitForPause = tools.get("wait_for_pause")!;

describe("resume", () => {
  it("not_paused error when not paused", async () => {
    setupSession();
    expect(parseErrorEnvelope(await resume.handler({}))?.error).toBe("not_paused");
  });

  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await resume.handler({}))?.error).toBe("no_session");
  });

  it("issues Debugger.resume against the paused session's id", async () => {
    const { fake, session } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.clearSentCalls();
    // Fire onResumed inside the send hook so the waitForResumed promise
    // resolves — required since `resume` now blocks on the
    // Debugger.resumed event before returning.
    fake.onSend("Debugger.resume", () => {
      session.pause.onResumed();
    });
    expect(parseOkEnvelope(await resume.handler({}))).toBe("resumed");
    const call = fake.sentCalls.find((c) => c.method === "Debugger.resume");
    // Critical: routed to the SAME session that paused, not the root.
    expect(call?.sessionId).toBe("SW1");
  });

  it("resume/resumed race 1: resumed event fires synchronously inside Debugger.resume send (same-batch case)", async () => {
    // Reproduces the same-WebSocket-batch race: CRI delivers the response
    // and the Debugger.resumed event back-to-back. Resume must observe the
    // event despite the listener being registered before send returns —
    // because waitForResumed installs the listener BEFORE send, the
    // synchronous onResumed call drains the resume waiter and the promise
    // resolves on this microtask.
    const { fake, session } = setupSession({ paused: true });
    let resumedFired = false;
    fake.onSend("Debugger.resume", () => {
      session.pause.onResumed();
      resumedFired = true;
    });
    expect(parseOkEnvelope(await resume.handler({}))).toBe("resumed");
    expect(resumedFired).toBe(true);
    // Post-condition: state cleared, so a follow-up wait_for_pause would
    // block for the NEXT pause rather than return the stale entry pause.
    expect(session.pause.isPaused()).toBe(false);
  });

  it("resume/resumed race 1: resumed event arrives async after Debugger.resume send returns", async () => {
    // The other ordering: send returns first, the resumed event lands a
    // tick later. resume must wait for it before returning.
    const { fake, session } = setupSession({ paused: true });
    let resumedFiredAt = 0;
    let resumeReturnedAt = 0;
    fake.onSend("Debugger.resume", () => {
      // Defer onResumed past the send's microtask. setImmediate runs after
      // the send promise resolves, so resume's await on the resumed
      // promise actually has to suspend.
      setImmediate(() => {
        session.pause.onResumed();
        resumedFiredAt = performance.now();
      });
    });
    const r = await resume.handler({});
    resumeReturnedAt = performance.now();
    expect(parseOkEnvelope(r)).toBe("resumed");
    // resume cannot have returned before the resumed event fired.
    expect(resumeReturnedAt).toBeGreaterThanOrEqual(resumedFiredAt);
    expect(session.pause.isPaused()).toBe(false);
  });

  it("resume/resumed race 1: PauseTracker.waitForResumed rejects on timeout (no resumed event)", async () => {
    // Bypasses the resume tool (which hard-codes 2s) and tests the
    // primitive directly so the timeout fires in <100ms.
    const { session } = setupSession({ paused: true });
    await expect(session.pause.waitForResumed(30).promise).rejects.toThrow(
      /Timed out.*Debugger\.resumed/,
    );
    // State unchanged because no resumed event landed.
    expect(session.pause.isPaused()).toBe(true);
  });

  it("resume failure path: Debugger.resume throws — tool surfaces error, no dangling waiter", async () => {
    // Regression for the failure-path race the first reviewer flagged.
    // If Debugger.resume rejects, the resumed waiter must be cancelled in
    // the resume tool's finally — otherwise it sits in resumeWaiters
    // until its 2s timer fires and rejects with no awaiter, producing an
    // unhandled rejection long after the tool already returned.
    const { fake, session } = setupSession({ paused: true });
    fake.respond("Debugger.resume", () => {
      throw new Error("boom — stale session / target detached");
    });
    const err = parseErrorEnvelope(await resume.handler({}));
    expect(err?.message).toMatch(/boom/);
    // The cancellation invariant: no leftover entries in resumeWaiters
    // after the tool returned with an error. Reaching into the private
    // state because the contract IS that no waiter is left behind —
    // there's no public observable for "resumeWaiters is empty" short of
    // waiting 2s for the would-be timer to either fire or not.
    expect((session.pause as any).resumeWaiters).toHaveLength(0);
  });
});

describe("step_over / step_into / step_out", () => {
  it("not_paused error when not paused", async () => {
    setupSession();
    expect(parseErrorEnvelope(await stepOver.handler({}))?.error).toBe("not_paused");
    setupSession();
    expect(parseErrorEnvelope(await stepInto.handler({}))?.error).toBe("not_paused");
    setupSession();
    expect(parseErrorEnvelope(await stepOut.handler({}))?.error).toBe("not_paused");
  });

  it("step_over: pause race — Debugger.paused fires synchronously inside stepOver send, must NOT desync", async () => {
    // Production pause-race regression (src/session/pause.ts:75 entry guard).
    // Real Chrome can deliver the stepOver response and the subsequent
    // Debugger.paused in the same WebSocket batch. The fake's onSend hook
    // reproduces that exactly: emit Debugger.paused synchronously inside
    // the stepOver responder. The waitForPauseOrResume call must still
    // resolve with the new pause state, not return null after timeout.
    const { fake, session } = setupSession({ paused: true });
    // Wire a Debugger.paused subscriber so connectDebugger's production
    // gate is mirrored — session.pause.onPaused is called by the
    // production handler, but here we drive it directly via the hook.
    fake.onSend("Debugger.stepOver", () => {
      // Production's onResumed has already been called by stepThen before
      // stepOver fires. We need to push the new pause state via the
      // PauseTracker directly because we're bypassing connectDebugger's
      // Debugger.paused handler.
      session.pause.onPaused(fake.makePauseState({ reason: "step", sessionId: undefined }));
    });
    const r = parseOkEnvelope<{ paused: boolean; reason: string }>(
      await stepOver.handler({ timeout_ms: 50 }),
    );
    expect(r.paused).toBe(true);
    expect(r.reason).toBe("step");
  });

  it("step_over: returns paused:false when no pause arrives within timeout", async () => {
    setupSession({ paused: true });
    const r = parseOkEnvelope<{ paused: boolean; message: string }>(
      await stepOver.handler({ timeout_ms: 30 }),
    );
    expect(r.paused).toBe(false);
    expect(r.message).toMatch(/did not pause/i);
  });

  it("step_into / step_out send the right CDP method", async () => {
    const ctx1 = setupSession({ paused: true });
    ctx1.fake.clearSentCalls();
    await stepInto.handler({ timeout_ms: 20 });
    expect(ctx1.fake.sentCalls.find((c) => c.method === "Debugger.stepInto")).toBeDefined();
    const ctx2 = setupSession({ paused: true });
    ctx2.fake.clearSentCalls();
    await stepOut.handler({ timeout_ms: 20 });
    expect(ctx2.fake.sentCalls.find((c) => c.method === "Debugger.stepOut")).toBeDefined();
  });

  it("step routes to the session that's currently paused (not always root)", async () => {
    // Captures the paused session BEFORE clearing pause state — required
    // because pauseState is cleared by onResumed before send fires.
    const { fake } = setupSession({ paused: true, pausedSessionId: "SW1" });
    fake.clearSentCalls();
    await stepOver.handler({ timeout_ms: 20 });
    const call = fake.sentCalls.find((c) => c.method === "Debugger.stepOver");
    expect(call?.sessionId).toBe("SW1");
  });

  it("explicit session selects the paused debugger when browser and Node are both live", async () => {
    const browser = setupSession({ paused: true });
    const node = setupAdditionalSession({ kind: "node", paused: true });
    browser.fake.clearSentCalls();
    node.fake.clearSentCalls();

    await stepOver.handler({ session: node.sessionId, timeout_ms: 20 });

    expect(node.fake.sentCalls.some((c) => c.method === "Debugger.stepOver")).toBe(true);
    expect(browser.fake.sentCalls.some((c) => c.method === "Debugger.stepOver")).toBe(false);
  });

  it("omitted session is ambiguous when browser and Node are both live", async () => {
    setupSession({ paused: true });
    setupAdditionalSession({ kind: "node", paused: true });
    expect(parseErrorEnvelope(await stepOver.handler({ timeout_ms: 20 }))?.error).toBe(
      "ambiguous_session",
    );
  });
});

describe("pause", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await pause.handler({}))?.error).toBe("no_session");
  });

  it("targets root by default; explicit session_id routes to that child", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    expect(
      parseOkEnvelope<{ paused_session: string | null }>(await pause.handler({})),
    ).toEqual({ paused_session: null });
    expect(fake.sentCalls.find((c) => c.method === "Debugger.pause")?.sessionId).toBeUndefined();

    fake.clearSentCalls();
    expect(
      parseOkEnvelope<{ paused_session: string | null }>(await pause.handler({ session_id: "SW1" })),
    ).toEqual({ paused_session: "SW1" });
    expect(fake.sentCalls.find((c) => c.method === "Debugger.pause")?.sessionId).toBe("SW1");
  });

  it("explicit null session_id is treated as root (matches the JSON null sentinel from list_targets)", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    expect(
      parseOkEnvelope<{ paused_session: string | null }>(await pause.handler({ session_id: null })),
    ).toEqual({ paused_session: null });
    expect(fake.sentCalls.find((c) => c.method === "Debugger.pause")?.sessionId).toBeUndefined();
  });

  it("composes debug-target session with child-CDP session_id", async () => {
    const browser = setupSession();
    const node = setupAdditionalSession({ kind: "node" });
    browser.fake.clearSentCalls();
    node.fake.clearSentCalls();

    await pause.handler({ session: node.sessionId, session_id: "CHILD_1" });

    expect(node.fake.sentCalls.find((c) => c.method === "Debugger.pause")?.sessionId).toBe(
      "CHILD_1",
    );
    expect(browser.fake.sentCalls.some((c) => c.method === "Debugger.pause")).toBe(false);
  });
});

describe("wait_for_pause", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await waitForPause.handler({}))?.error).toBe("no_session");
  });

  it("returns immediately when already paused (with the TS-mapped call stack)", async () => {
    const browser = setupSession({ paused: true, label: "frontend" });
    const r = parseOkEnvelope<{
      session: string;
      label: string | null;
      reason: string;
      call_stack: any[];
    }>(
      await waitForPause.handler({ timeout_ms: 100 }),
    );
    expect(r.session).toBe(browser.sessionId);
    expect(r.label).toBe("frontend");
    expect(r.reason).toBe("breakpoint");
    expect(r.call_stack).toHaveLength(1);
    expect(r.call_stack[0].function_name).toBe("computeStep");
  });

  it("times out: PauseTracker.waitForPause rejects, the error envelope surfaces as pause_timeout", async () => {
    setupSession();
    // wait_for_pause uses waitForPause (not waitForPauseOrResume), which
    // REJECTS on timeout. The handler enriches it into a pause_timeout error.
    const r = await waitForPause.handler({ timeout_ms: 30 });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("pause_timeout");
    expect(err?.message).toMatch(/Timed out/);
  });

  it("timeout diagnostic: reports that an owned Node target already exited", async () => {
    const { session } = setupSession({ kind: "node" });
    // Simulate a launch_node child that ran to completion before pausing.
    session.ownedProcess = { kind: "node", handle: { exitCode: 0, signalCode: null } as any };
    const err = parseErrorEnvelope(await waitForPause.handler({ timeout_ms: 20 }));
    expect(err?.error).toBe("pause_timeout");
    expect(err?.message).toMatch(/exited/i);
    expect(err?.message).toContain("exit code 0");
  });

  it("timeout diagnostic: lists never-fired conditional breakpoints with resolved TS location + condition", async () => {
    const { session } = setupSession();
    session.breakpoints.set("bp_1", {
      id: "bp_1",
      file: "conditional-bp.ts",
      line: 14,
      condition: "i === 3",
      resolvedLocations: [{ file: "conditional-bp.ts", line: 15, column: 0 }],
      bindings: [],
    });
    const err = parseErrorEnvelope(await waitForPause.handler({ timeout_ms: 20 }));
    expect(err?.error).toBe("pause_timeout");
    expect(err?.message).toContain("bp_1");
    expect(err?.message).toContain("conditional-bp.ts:15");
    expect(err?.message).toContain("i === 3");
    expect(err?.message).toContain("get_source");
  });

  it("returns the session_id of the paused frame so agents can route follow-on calls", async () => {
    setupSession({ paused: true, pausedSessionId: "SW1" });
    const r = parseOkEnvelope<{ session_id: string | null; call_stack: any[] }>(
      await waitForPause.handler({ timeout_ms: 100 }),
    );
    expect(r.session_id).toBe("SW1");
    expect(r.call_stack[0].session_id).toBe("SW1");
  });

  it("explicit session scopes the wait when browser and Node are both paused", async () => {
    setupSession({ paused: true, pausedSessionId: "BROWSER_CHILD" });
    const node = setupAdditionalSession({
      kind: "node",
      paused: true,
      pausedSessionId: "NODE_CHILD",
    });
    const r = parseOkEnvelope<{ session_id: string | null }>(
      await waitForPause.handler({ session: node.sessionId, timeout_ms: 100 }),
    );
    expect(r.session_id).toBe("NODE_CHILD");
  });

  it("omitted session races every live target, returns the winner identity, and cancels losers", async () => {
    const browser = setupSession({ label: "frontend" });
    const node = setupAdditionalSession({ kind: "node", label: "backend" });

    const pending = waitForPause.handler({ timeout_ms: 1000 });
    expect((browser.session.pause as any).waiters).toHaveLength(1);
    expect((node.session.pause as any).waiters).toHaveLength(1);

    node.session.pause.onPaused(
      node.fake.makePauseState({ sessionId: "NODE_CHILD" }),
    );
    const r = parseOkEnvelope<{
      session: string;
      label: string | null;
      session_id: string | null;
    }>(await pending);

    expect(r).toMatchObject({
      session: node.sessionId,
      label: "backend",
      session_id: "NODE_CHILD",
    });
    expect((browser.session.pause as any).waiters).toHaveLength(0);
    expect((node.session.pause as any).waiters).toHaveLength(0);
  });

  it("raced mode surfaces an already-paused participant immediately", async () => {
    const browser = setupSession({ paused: true, label: "frontend" });
    const node = setupAdditionalSession({ kind: "node", label: "backend" });

    const r = parseOkEnvelope<{ session: string; label: string | null }>(
      await waitForPause.handler({ timeout_ms: 100 }),
    );

    expect(r).toMatchObject({
      session: browser.sessionId,
      label: "frontend",
    });
    expect((node.session.pause as any).waiters).toHaveLength(0);
  });

  it("raced mode snapshots participants when the call starts", async () => {
    const browser = setupSession();
    const pending = waitForPause.handler({ timeout_ms: 20 });
    const node = setupAdditionalSession({ kind: "node", paused: true });

    expect((browser.session.pause as any).waiters).toHaveLength(1);
    expect((node.session.pause as any).waiters).toHaveLength(0);
    expect(parseErrorEnvelope(await pending)?.error).toBe("pause_timeout");
    expect((browser.session.pause as any).waiters).toHaveLength(0);
  });

  it("closing one race participant removes it while another target can still win", async () => {
    const browser = setupSession({ label: "frontend" });
    const node = setupAdditionalSession({ kind: "node", label: "backend" });
    const pending = waitForPause.handler({ timeout_ms: 1000 });

    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    (node.session.client as any).close = () => closeGate;
    const closing = registry.close(node.sessionId);

    // close() is deliberately still blocked on the fake CDP socket, but its
    // pause waiter must already be gone — teardown latency cannot hold a race
    // participant open.
    expect((node.session.pause as any).waiters).toHaveLength(0);
    expect((browser.session.pause as any).waiters).toHaveLength(1);
    browser.session.pause.onPaused(browser.fake.makePauseState());

    try {
      const r = parseOkEnvelope<{ session: string; label: string | null }>(await pending);
      expect(r).toMatchObject({ session: browser.sessionId, label: "frontend" });
      expect((browser.session.pause as any).waiters).toHaveLength(0);
    } finally {
      releaseClose();
      await closing;
    }
  });

  it("closing every race participant rejects with no_session and leaves no waiters", async () => {
    const browser = setupSession();
    const node = setupAdditionalSession({ kind: "node" });
    const pending = waitForPause.handler({ timeout_ms: 1000 });

    await Promise.all([
      registry.close(browser.sessionId),
      registry.close(node.sessionId),
    ]);

    expect(parseErrorEnvelope(await pending)?.error).toBe("no_session");
    expect((browser.session.pause as any).waiters).toHaveLength(0);
    expect((node.session.pause as any).waiters).toHaveLength(0);
  });

  it("a raced timeout names the multi-session wait and cancels every waiter", async () => {
    const browser = setupSession();
    const node = setupAdditionalSession({ kind: "node" });
    const err = parseErrorEnvelope(
      await waitForPause.handler({ timeout_ms: 20 }),
    );

    expect(err?.error).toBe("pause_timeout");
    expect(err?.message).toContain("any live session");
    expect((browser.session.pause as any).waiters).toHaveLength(0);
    expect((node.session.pause as any).waiters).toHaveLength(0);
  });
});

describe("registration metadata", () => {
  it("registers exactly the six execution tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "pause",
      "resume",
      "step_into",
      "step_out",
      "step_over",
      "wait_for_pause",
    ]);
  });

  it("uses the centralized raced-session description", () => {
    const schema = waitForPause.inputSchema as Record<
      string,
      { description?: string }
    >;
    expect(schema.session?.description).toBe(RACED_WAIT_SESSION_DESC);
    expect(waitForPause.description).toContain("already-paused participant");
    expect(waitForPause.description).toContain("when the call starts");
  });
});
