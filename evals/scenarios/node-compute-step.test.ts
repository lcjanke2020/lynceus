// Unit tests for the node-compute-step oracle.
//
// The oracle is pure: (trace, finalAnswer) -> OracleResult. Feed it
// synthetic traces representing different agent behaviors and assert
// the verdict. Mirrors compute-step.test.ts but tailored to the Node
// canonical workflow — set_breakpoint id-membership in
// wait_for_pause.hit_breakpoint_ids is the load-bearing mechanic check.

import { describe, it, expect } from "vitest";
import { nodeComputeStep } from "./node-compute-step.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

function fullySuccessfulTrace(bpLine: number, bpId = "bp_1"): TraceEntry[] {
  return [
    ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/compute-step.js" }, {
      sessionId: "S1",
      pid: 12345,
    }),
    ...pair(
      "2",
      "set_breakpoint",
      { file: "compute-step.ts", line: bpLine },
      { id: bpId, resolved_locations: [{ file: "compute-step.ts", line: bpLine }] },
    ),
    ...pair("3", "resume", {}, "resumed"),
    ...pair(
      "4",
      "wait_for_pause",
      { timeout_ms: 10000 },
      { reason: "other", hit_breakpoint_ids: [bpId], call_stack: [] },
    ),
    ...pair("5", "get_call_stack", {}, { frames: [{ functionName: "computeStep" }] }),
    ...pair("6", "resume", {}, "resumed"),
  ];
}

describe("node-compute-step oracle", () => {
  it("passes when the agent sets bp on compute-step.ts, the pause's hit_breakpoint_ids contains it, inspects, and names compute-step.ts:7", () => {
    const trace = fullySuccessfulTrace(7);
    const finalAnswer =
      "The bug is in compute-step.ts:7 — `const step = 2;` should be 1.";
    const out = nodeComputeStep.oracle(trace, finalAnswer);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("accepts answers that name the computeStep function instead of the line number", () => {
    const trace = fullySuccessfulTrace(7);
    const out = nodeComputeStep.oracle(
      trace,
      "Bug is in compute-step.ts inside computeStep — it returns 2.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("fails mechanic when no set_breakpoint was made on compute-step.ts (correctness still 1)", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/compute-step.js" }, {
        sessionId: "S1",
        pid: 12345,
      }),
      // No set_breakpoint on compute-step.ts.
      ...pair("2", "resume", {}, "resumed"),
      ...pair(
        "3",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "other", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair("4", "get_call_stack", {}, { frames: [] }),
    ];
    const out = nodeComputeStep.oracle(trace, "compute-step.ts:7 is the bug");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no set_breakpoint on compute-step.ts/);
  });

  it("fails mechanic when wait_for_pause returned but hit_breakpoint_ids is empty (only the entry pause was observed)", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/compute-step.js" }, {
        sessionId: "S1",
        pid: 12345,
      }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "compute-step.ts", line: 7 },
        { id: "bp_1", resolved_locations: [{ file: "compute-step.ts", line: 7 }] },
      ),
      // Agent observed the entry pause (no resume between launch and wait) —
      // hit_breakpoint_ids is empty, so this does NOT count as the bp firing.
      ...pair(
        "3",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair("4", "get_call_stack", {}, { frames: [] }),
    ];
    const out = nodeComputeStep.oracle(trace, "compute-step.ts:7 — computeStep returns 2");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/hit_breakpoint_ids includes a bp set on compute-step.ts/);
  });

  it("fails mechanic when wait_for_pause.hit_breakpoint_ids lists a DIFFERENT id than the one set (bp set but not hit)", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/compute-step.js" }, {
        sessionId: "S1",
        pid: 12345,
      }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "compute-step.ts", line: 7 },
        { id: "bp_ours", resolved_locations: [{ file: "compute-step.ts", line: 7 }] },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "other", hit_breakpoint_ids: ["bp_someoneelse"], call_stack: [] },
      ),
      ...pair("5", "get_call_stack", {}, { frames: [] }),
    ];
    const out = nodeComputeStep.oracle(trace, "compute-step.ts:7 — computeStep returns 2");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/hit_breakpoint_ids includes a bp set on compute-step.ts/);
  });

  it("fails mechanic when the only successful inspection happened during the entry pause (before bp hit)", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/compute-step.js" }, {
        sessionId: "S1",
        pid: 12345,
      }),
      // Pre-bp inspection during the entry pause — succeeds because the entry
      // pause is active when launch_node returns.
      ...pair("2", "get_scope", {}, { items: [] }),
      ...pair(
        "3",
        "set_breakpoint",
        { file: "compute-step.ts", line: 7 },
        { id: "bp_1", resolved_locations: [{ file: "compute-step.ts", line: 7 }] },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "other", hit_breakpoint_ids: ["bp_1"], call_stack: [] },
      ),
      // No inspection AFTER the bp-hit pause.
      ...pair("6", "resume", {}, "resumed"),
    ];
    const out = nodeComputeStep.oracle(
      trace,
      "compute-step.ts:7 — computeStep returns 2 instead of 1.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful inspection after the bp-hit pause/);
  });

  it("fails correctness when final answer does not mention compute-step.ts", () => {
    const trace = fullySuccessfulTrace(7);
    const out = nodeComputeStep.oracle(
      trace,
      "There is a bug somewhere in the counter increment logic.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/does not mention compute-step.ts/);
  });

  it("fails correctness when answer mentions compute-step.ts but not the line or symbol", () => {
    const trace = fullySuccessfulTrace(7);
    const out = nodeComputeStep.oracle(
      trace,
      "compute-step.ts has the bug but I can't pinpoint where.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/does not name the bug line/);
  });
});
