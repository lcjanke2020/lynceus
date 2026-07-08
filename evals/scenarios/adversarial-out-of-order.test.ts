import { describe, it, expect } from "vitest";
import { adversarialOutOfOrder } from "./adversarial-out-of-order.js";
import { pair } from "./_test-helpers.js";

const PASS_ANSWER = "The bug is in handlers.ts:12 — computeStep returns 2.";

describe("adversarial-out-of-order oracle", () => {
  it("passes when the agent recovered from a wrong-order call and solved", () => {
    const trace = [
      // Agent tries get_call_stack first (no pause) → error
      ...pair("1", "get_call_stack", {}, { error: "not_paused" }, true, "not_paused"),
      // Recovers: attach, navigate, set breakpoint, click, wait
      ...pair("2", "attach_chrome", { port: 9222 }, { targetId: "T1" }),
      ...pair("3", "navigate", { url: "x" }, { url: "x" }),
      ...pair("4", "set_breakpoint", { file: "handlers.ts", line: 12 }, { id: "bp" }),
      ...pair("5", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("6", "wait_for_pause", { timeout_ms: 5000 }, { reason: "other", call_stack: [] }),
      ...pair("7", "get_scope", {}, { items: [] }),
      ...pair("8", "resume", {}, "resumed"),
    ];
    expect(adversarialOutOfOrder.oracle(trace, PASS_ANSWER).correctness).toBe(1);
  });

  it("passes a clean solve and notes the absence of recovery (PR #15 review)", () => {
    // A model that already knows the right ordering and never errs is a
    // legitimate pass — recovery is signal, not a correctness gate. The
    // diagnostic note distinguishes the two cases for cross-model diff.
    const trace = [
      ...pair("1", "attach_chrome", { port: 9222 }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "set_breakpoint", { file: "handlers.ts", line: 12 }, { id: "bp" }),
      ...pair("4", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("5", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("6", "get_scope", {}, { items: [] }),
      ...pair("7", "resume", {}, "resumed"),
    ];
    const out = adversarialOutOfOrder.oracle(trace, PASS_ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.notes).toMatch(/no errors observed/);
  });

  it("fails mechanic when the agent took more than 15 tool calls (brute-forced)", () => {
    const trace: ReturnType<typeof pair>[number][] = [];
    // 9 error-then-retry rounds = 18 calls
    for (let i = 1; i <= 9; i++) {
      trace.push(
        ...pair(`${i}a`, "get_call_stack", {}, { error: "not_paused" }, true, "not_paused"),
        ...pair(`${i}b`, "set_breakpoint", { file: "handlers.ts", line: 12 }, { id: "bp" }),
      );
    }
    const out = adversarialOutOfOrder.oracle(trace, PASS_ANSWER);
    // Final answer is correct → correctness=1; brute-forced (>15 calls) → mechanic=0.
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("is tagged xfailMechanic (a statically-readable bug can't force the pause flow — LEO-400)", () => {
    expect(adversarialOutOfOrder.xfailMechanic).toBe(true);
  });
});
