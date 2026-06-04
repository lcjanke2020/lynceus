// Unit tests for the compute-step oracle.
//
// The oracle is a pure function: (trace, finalAnswer) → OracleResult.
// Feed it synthetic traces representing different agent behaviors and
// assert the verdict. Costs nothing per run; catches oracle regressions
// the moment they land.

import { describe, it, expect } from "vitest";
import { computeStep } from "./compute-step.js";
import type { TraceEntry } from "../harness/types.js";

function call(toolUseId: string, tool: string, input: unknown): TraceEntry {
  return { t: "tool_call", ts: "x", iter: 1, toolUseId, tool, input };
}
function result(
  toolUseId: string,
  tool: string,
  isError: boolean,
  output: unknown,
  errorCode?: string,
): TraceEntry {
  return {
    t: "tool_result",
    ts: "x",
    iter: 1,
    toolUseId,
    tool,
    isError,
    output,
    ...(errorCode ? { errorCode } : {}),
  };
}

function fullySuccessfulTrace(bpLine: number): TraceEntry[] {
  return [
    call("1", "launch_chrome", { headless: true }),
    result("1", "launch_chrome", false, { targetId: "T1" }),
    call("2", "navigate", { url: "http://x" }),
    result("2", "navigate", false, { url: "http://x" }),
    call("3", "set_breakpoint", { file: "handlers.ts", line: bpLine }),
    result("3", "set_breakpoint", false, { id: "bp_1", resolved_locations: [{ file: "handlers.ts", line: bpLine }] }),
    call("4", "click", { selector: "#go" }),
    result("4", "click", false, { clicked: "#go" }),
    call("5", "wait_for_pause", { timeout_ms: 10000 }),
    result("5", "wait_for_pause", false, { reason: "other", call_stack: [] }),
    call("6", "get_scope", {}),
    result("6", "get_scope", false, { items: [{ name: "count", preview: "0" }] }),
    call("7", "resume", {}),
    result("7", "resume", false, "resumed"),
  ];
}

describe("compute-step oracle", () => {
  it("passes when the agent does breakpoint + click + wait_for_pause + inspection + names handlers.ts:12", () => {
    const trace = fullySuccessfulTrace(12);
    const finalAnswer = "The bug is in handlers.ts:12 — `computeStep()` returns 2 instead of 1.";
    const out = computeStep.oracle(trace, finalAnswer);
    expect(out.correctness).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("passes when the answer names the function rather than the line number", () => {
    const trace = fullySuccessfulTrace(11);
    const finalAnswer = "Bug is in handlers.ts inside computeStep — it returns 2.";
    expect(computeStep.oracle(trace, finalAnswer).correctness).toBe(1);
  });

  it("fails when no breakpoint was set on handlers.ts", () => {
    const trace: TraceEntry[] = [
      call("1", "launch_chrome", { headless: true }),
      result("1", "launch_chrome", false, { targetId: "T1" }),
      call("2", "navigate", { url: "http://x" }),
      result("2", "navigate", false, { url: "http://x" }),
      // No set_breakpoint on handlers.ts.
      call("3", "click", { selector: "#go" }),
      result("3", "click", false, { clicked: "#go" }),
    ];
    const out = computeStep.oracle(trace, "handlers.ts:12 is the bug");
    // Final answer is correct → correctness=1; workflow missing → mechanic=0.
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no set_breakpoint on handlers.ts/);
  });

  it("fails mechanic when wait_for_pause never returned a pause", () => {
    const trace: TraceEntry[] = [
      ...fullySuccessfulTrace(12).filter((e) => !(e.t === "tool_result" && e.tool === "wait_for_pause")),
      // Replace with a timeout-style error envelope.
      result("5", "wait_for_pause", true, { error: "internal_error", message: "timed out" }, "internal_error"),
    ];
    const out = computeStep.oracle(trace, "handlers.ts:12 is the bug");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/wait_for_pause never returned a pause/);
  });

  it("fails when the final answer doesn't mention handlers.ts", () => {
    const trace = fullySuccessfulTrace(12);
    const out = computeStep.oracle(trace, "There's a bug in the math function returning the wrong value.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/does not mention handlers.ts/);
  });

  it("fails when the final answer mentions handlers.ts but not the line or function", () => {
    const trace = fullySuccessfulTrace(12);
    const out = computeStep.oracle(trace, "handlers.ts contains the bug but I can't pinpoint where.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/does not name the bug line/);
  });

  it("accepts breakpoints on any of handlers.ts:{6,7,8,11,12} as plausible", () => {
    // The oracle only checks file=handlers.ts, not specific lines, since
    // an agent could reasonably break at the call site (line 6) or the
    // bug (line 12) or anywhere between.
    for (const line of [6, 7, 8, 11, 12]) {
      const out = computeStep.oracle(
        fullySuccessfulTrace(line),
        "Bug is handlers.ts:12 in computeStep",
      );
      expect(out.correctness, `line ${line} should pass`).toBe(1);
    }
  });
});
