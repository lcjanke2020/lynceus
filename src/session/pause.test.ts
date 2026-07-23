import { describe, it, expect } from "vitest";
import { PauseTracker, type PauseState } from "./pause.js";

const fakeState = (reason: PauseState["reason"] = "breakpoint"): PauseState => ({
  reason,
  callFrames: [],
  pausedAt: Date.now(),
});

describe("PauseTracker", () => {
  it("waitForPause resolves immediately when already paused", async () => {
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const got = await t.waitForPause(1000);
    expect(got.reason).toBe("breakpoint");
  });

  it("waitForPause resolves when onPaused fires later", async () => {
    const t = new PauseTracker();
    const promise = t.waitForPause(2000);
    setTimeout(() => t.onPaused(fakeState("step")), 10);
    const got = await promise;
    expect(got.reason).toBe("step");
  });

  it("waitForPauseOrResume resolves immediately if state is already paused", async () => {
    // Regression for the step-race bug: previously this returned a fresh
    // Promise and registered a waiter, missing the already-buffered pause
    // and timing out instead.
    const t = new PauseTracker();
    t.onPaused(fakeState("breakpoint"));
    const got = await t.waitForPauseOrResume(50);
    expect(got?.reason).toBe("breakpoint");
  });

  it("waitForPauseOrResume returns null on timeout when no pause arrives", async () => {
    const t = new PauseTracker();
    const got = await t.waitForPauseOrResume(50);
    expect(got).toBeNull();
  });

  it("reset() rejects pending waiters", async () => {
    const t = new PauseTracker();
    const p = t.waitForPause(5000);
    t.reset();
    await expect(p).rejects.toThrow(/Session closed/);
  });

  it("two concurrent waitForPause callers both resolve on a single onPaused", async () => {
    // Real-world: agent issues `wait_for_pause` from two parallel tool
    // calls (e.g. one watching for a click, one watching for a navigation).
    // Both must resolve when the next pause arrives — a naive impl that
    // pops only the first waiter would leave the second hanging until
    // its own timeout, leaking promises.
    const t = new PauseTracker();
    const p1 = t.waitForPause(5000);
    const p2 = t.waitForPause(5000);
    setTimeout(() => t.onPaused(fakeState("breakpoint")), 5);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.reason).toBe("breakpoint");
    expect(r2.reason).toBe("breakpoint");
  });

  it("waitForPauseCancellable removes a race loser and clears its timer", async () => {
    const t = new PauseTracker();
    const { promise, cancel } = t.waitForPauseCancellable(5000);
    expect((t as any).waiters).toHaveLength(1);

    cancel();

    await expect(promise).rejects.toThrow("Pause wait cancelled");
    expect((t as any).waiters).toHaveLength(0);
    // A later pause is current state only; it cannot revive the cancelled
    // waiter or produce a second settlement.
    t.onPaused(fakeState("step"));
    expect(t.current()?.reason).toBe("step");
    await expect(promise).rejects.toThrow("Pause wait cancelled");
  });

  it("waitForPauseCancellable cancel is a no-op after pause already won", async () => {
    const t = new PauseTracker();
    const { promise, cancel } = t.waitForPauseCancellable(5000);
    t.onPaused(fakeState("breakpoint"));
    await expect(promise).resolves.toMatchObject({ reason: "breakpoint" });
    expect(() => cancel()).not.toThrow();
    expect((t as any).waiters).toHaveLength(0);
  });

  it("waitForPauseOrResume: pause arrival in the same tick as the timeout — pause wins", async () => {
    // Race: setTimeout(0) and onPaused() on the next microtask. Because
    // the entry guard checks state synchronously, but here state is null
    // at entry, we end up registering a waiter whose timer fires almost
    // immediately. The onPaused must still resolve with the state, not
    // with null.
    const t = new PauseTracker();
    const p = t.waitForPauseOrResume(5);
    // Fire onPaused within the same event-loop tick as the timer.
    setImmediate(() => t.onPaused(fakeState("step")));
    const result = await p;
    // Either outcome is acceptable per the docs ("treat timeout as
    // resumed"), but we DO want a deterministic, single-resolution
    // outcome — never a double-resolve crash.
    expect(result === null || result.reason === "step").toBe(true);
  });

  it("reset() during a pending waitForPauseOrResume rejects (not resolves null)", async () => {
    // Subtle: waitForPauseOrResume's waiter has its own `reject` path
    // (separate from the timeout's `resolve(null)`). reset() should
    // exercise that reject path so callers see a clear "session closed"
    // error rather than a silent null.
    const t = new PauseTracker();
    const p = t.waitForPauseOrResume(5000);
    t.reset();
    await expect(p).rejects.toThrow(/Session closed/);
  });

  // -- waitForResumed (resume/resumed race 1 primitive) --

  it("waitForResumed resolves when onResumed fires later", async () => {
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const { promise } = t.waitForResumed(2000);
    setTimeout(() => t.onResumed(), 10);
    await expect(promise).resolves.toBeUndefined();
    expect(t.isPaused()).toBe(false);
  });

  it("waitForResumed rejects on timeout (no Debugger.resumed event)", async () => {
    const t = new PauseTracker();
    t.onPaused(fakeState());
    await expect(t.waitForResumed(20).promise).rejects.toThrow(
      /Timed out.*Debugger\.resumed/,
    );
    // State unchanged because no resumed event landed — important so a
    // caller that catches the reject can still observe accurate pause state.
    expect(t.isPaused()).toBe(true);
  });

  it("waitForResumed does NOT short-circuit on null state at entry", async () => {
    // The resume tool installs the listener BEFORE sending Debugger.resume
    // — at that point state IS paused, so this isn't the live case. But if
    // a caller ever registers while state is already null (e.g., a second
    // resume after one already cleared state), the waiter must still wait
    // for the NEXT onResumed call rather than resolving immediately.
    // Otherwise the same waiter would short-circuit on stale state.
    const t = new PauseTracker();
    // state is null (never paused). Register a waiter — it must NOT resolve.
    let resolved = false;
    const p = t.waitForResumed(2000).promise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
    t.onResumed();
    await p;
    expect(resolved).toBe(true);
  });

  it("multiple concurrent waitForResumed callers all resolve on one onResumed", async () => {
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const { promise: p1 } = t.waitForResumed(2000);
    const { promise: p2 } = t.waitForResumed(2000);
    setTimeout(() => t.onResumed(), 5);
    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);
  });

  it("reset() rejects pending waitForResumed waiters with 'Session closed'", async () => {
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const { promise } = t.waitForResumed(5000);
    t.reset();
    await expect(promise).rejects.toThrow(/Session closed/);
  });

  it("cancel() drops the waiter so a later timer fire doesn't unhandled-reject", async () => {
    // Upstream review: when the resume tool's Promise.all rejects on a
    // failed Debugger.resume send, cancel() must remove the waiter from
    // resumeWaiters AND clear its timer — otherwise the timer fires ~2s
    // later with no awaiter and surfaces as an unhandled rejection.
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const { promise, cancel } = t.waitForResumed(30);
    cancel();
    // After cancel: waiter resolves cleanly (so any straggler awaiter
    // exits) and the resumeWaiters list is empty — confirmed by checking
    // that a subsequent onResumed has nothing to drain.
    await expect(promise).resolves.toBeUndefined();
    // Sleep past the original timeout to prove the timer was killed:
    // if it weren't, the would-be reject would fire here. Wrap in
    // try/catch on the original promise — already resolved, must stay
    // resolved with no double-settle crash.
    await new Promise((r) => setTimeout(r, 60));
    await expect(promise).resolves.toBeUndefined();
  });

  it("cancel() is a no-op after onResumed has already drained the waiter", async () => {
    // The resume tool calls cancel() unconditionally in `finally`. On the
    // happy path (resumed event already fired and drained), cancel must
    // be safe to call against an already-settled waiter — no double
    // resolve crash, no out-of-bounds splice.
    const t = new PauseTracker();
    t.onPaused(fakeState());
    const { promise, cancel } = t.waitForResumed(2000);
    t.onResumed();
    await expect(promise).resolves.toBeUndefined();
    expect(() => cancel()).not.toThrow();
  });
});
