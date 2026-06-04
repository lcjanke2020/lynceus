import { describe, it, expect } from "vitest";
import { conditionalBp } from "./conditional-bp.js";
import { pair } from "./_test-helpers.js";

describe("conditional-bp oracle", () => {
  const ANSWER = "handlers.ts: bug fires on the third click — increment is wrong when count >= 2.";

  it("passes when the agent used a conditional breakpoint", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "set_breakpoint", { file: "handlers.ts", line: 6, condition: "count >= 2" }, { id: "bp" }),
      ...pair("4", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("5", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("6", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("7", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("8", "get_scope", {}, { items: [] }),
      ...pair("9", "resume", {}, "resumed"),
    ];
    expect(conditionalBp.oracle(trace, ANSWER).correctness).toBe(1);
  });

  it("passes when the agent brute-forced with ≥3 clicks (less elegant, still valid)", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "set_breakpoint", { file: "handlers.ts", line: 6 }, { id: "bp" }),
      ...pair("4", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("5", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("6", "resume", {}, "resumed"),
      ...pair("7", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("8", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("9", "resume", {}, "resumed"),
      ...pair("10", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("11", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("12", "get_scope", {}, { items: [] }),
    ];
    expect(conditionalBp.oracle(trace, ANSWER).correctness).toBe(1);
  });

  it("fails mechanic when the agent only clicked once (didn't reach the bug)", () => {
    const trace = [
      ...pair("1", "set_breakpoint", { file: "handlers.ts", line: 6 }, { id: "bp" }),
      ...pair("2", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("3", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("4", "get_scope", {}, { items: [] }),
    ];
    const out = conditionalBp.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails when the answer doesn't describe the third-click trigger", () => {
    const trace = [
      ...pair("1", "set_breakpoint", { file: "handlers.ts", line: 6, condition: "count >= 2" }, { id: "bp" }),
      ...pair("2", "click", {}, {}),
      ...pair("3", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("4", "get_scope", {}, {}),
    ];
    expect(
      conditionalBp.oracle(trace, "handlers.ts has a bug.").correctness,
    ).toBe(0);
  });
});
