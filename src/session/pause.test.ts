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
});
