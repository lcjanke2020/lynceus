import { describe, it, expect } from "vitest";
import { deepSourceMap } from "./deep-source-map.js";
import { pair } from "./_test-helpers.js";

describe("deep-source-map oracle", () => {
  // ANSWER must name the actual buggy expression (a + b + 1) — see oracle.
  // A vague "math.ts returns wrong" would just parrot the prompt's
  // mention of math.ts without proving the agent inspected the code.
  const ANSWER = "Bug: src/lib/utils/math.ts:8 — add() returns `a + b + 1` instead of `a + b`.";

  it("passes with suffix-match breakpoint (file ending in math.ts)", () => {
    const trace = [
      ...pair("1", "list_scripts", {}, [{ url: "x", original_sources: ["src/lib/utils/math.ts"] }]),
      ...pair("2", "set_breakpoint", { file: "math.ts", line: 4 }, { id: "bp" }),
      ...pair("3", "click", {}, {}),
      ...pair("4", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
      ...pair("5", "get_scope", {}, {}),
      ...pair("6", "resume", {}, "resumed"),
    ];
    expect(deepSourceMap.oracle(trace, ANSWER).correctness).toBe(1);
  });

  it("passes with full-path breakpoint (lib/utils/math.ts)", () => {
    const trace = [
      ...pair("1", "set_breakpoint", { file: "src/lib/utils/math.ts", line: 4 }, { id: "bp" }),
      ...pair("2", "click", {}, {}),
      ...pair("3", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
    ];
    expect(deepSourceMap.oracle(trace, ANSWER).correctness).toBe(1);
  });

  it("fails mechanic when the breakpoint is on the wrong file", () => {
    const trace = [
      ...pair("1", "set_breakpoint", { file: "handlers.ts", line: 6 }, { id: "bp" }),
      ...pair("2", "click", {}, {}),
      ...pair("3", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
    ];
    const out = deepSourceMap.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails when the answer doesn't mention math.ts or the deep path", () => {
    const trace = [
      ...pair("1", "set_breakpoint", { file: "math.ts", line: 4 }, { id: "bp" }),
      ...pair("2", "click", {}, {}),
      ...pair("3", "wait_for_pause", {}, { reason: "other", call_stack: [] }),
    ];
    expect(
      deepSourceMap.oracle(trace, "There's a bug somewhere in the math.").correctness,
    ).toBe(0);
  });
});
