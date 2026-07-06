// Unit tests for the node-stdio-bug oracle.
//
// Feed synthetic traces representing different agent behaviors and
// assert the verdict. The load-bearing case is the "agent used
// get_console_logs instead of get_node_output" rejection — that's the
// whole reason this scenario exists.

import { describe, it, expect } from "vitest";
import { nodeStdioBug } from "./node-stdio-bug.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

const STDIO_BUG_BP_LINE = 12;
const STDIO_BUG_BP_ID = "bp_stdio_1";

/** A canonical successful trace: launch_node → set_breakpoint on stdio-bug.ts
 *  → resume past entry pause → wait_for_pause (bp hit) → inspect (get_scope) →
 *  resume → get_node_output after script terminates.
 *  Order matters: in real execution stdout flushes AFTER `accumulate`
 *  returns, so get_node_output's `total: 20` line only appears once the
 *  script has run to completion. */
function fullySuccessfulTrace(): TraceEntry[] {
  return [
    ...pair("1", "launch_node", { script: "examples/sample-node-app/dist/stdio-bug.js" }, {
      sessionId: "node-1",
      target: { kind: "node" },
    }),
    ...pair("2", "set_breakpoint", { file: "stdio-bug.ts", line: STDIO_BUG_BP_LINE }, {
      id: STDIO_BUG_BP_ID,
      resolved_locations: [{ file: "stdio-bug.ts", line: STDIO_BUG_BP_LINE }],
    }),
    ...pair("3", "resume", {}, "resumed"),
    ...pair("4", "wait_for_pause", { timeout_ms: 10000 }, {
      reason: "other",
      hit_breakpoint_ids: [STDIO_BUG_BP_ID],
      call_stack: [{ function: "accumulate", file: "stdio-bug.ts", line: 12 }],
    }),
    ...pair("5", "get_scope", {}, {
      items: [
        { name: "total", preview: "1" },
        { name: "v", preview: "1" },
      ],
    }),
    ...pair("6", "resume", {}, "resumed"),
    ...pair("7", "get_node_output", {}, {
      cursor: 1,
      items: [{ seq: 1, ts: "x", stream: "stdout", text: "total: 20\n" }],
    }),
  ];
}

describe("node-stdio-bug oracle", () => {
  it("passes when the agent does get_node_output + bp hit + inspect + names stdio-bug.ts:12", () => {
    const trace = fullySuccessfulTrace();
    const finalAnswer =
      "The bug is in stdio-bug.ts:12 — the accumulator does `total += v + 1` instead of `total += v`, so the printed total is 20 instead of 15.";
    const out = nodeStdioBug.oracle(trace, finalAnswer);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("fails mechanic when the agent used get_console_logs instead of get_node_output", () => {
    // The load-bearing test. Substitute the get_node_output call with a
    // get_console_logs call — channel-separation contract: the fixture
    // prints via process.stdout.write so the V8 console-API stream is
    // empty. Correctness can still be 1 (the agent might have figured
    // out the bug from inspection alone), but mechanic must be 0
    // because the raw-stdout channel was never read.
    const trace: TraceEntry[] = fullySuccessfulTrace().map((e) => {
      if (e.t === "tool_call" && e.toolUseId === "7") {
        return { ...e, tool: "get_console_logs", input: {} };
      }
      if (e.t === "tool_result" && e.toolUseId === "7") {
        return { ...e, tool: "get_console_logs", output: { items: [] } };
      }
      return e;
    });
    const out = nodeStdioBug.oracle(
      trace,
      "stdio-bug.ts:12 — `accumulate` adds v+1 per iteration.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/get_node_output/);
  });

  it("fails mechanic when no breakpoint was hit (hit_breakpoint_ids mismatched)", () => {
    // set_breakpoint succeeded; wait_for_pause returned a pause but
    // hit_breakpoint_ids carries a different id (e.g. the V8 entry-pause
    // doesn't fire on one of our bps).
    const trace: TraceEntry[] = fullySuccessfulTrace().map((e) => {
      if (e.t === "tool_result" && e.toolUseId === "4") {
        return {
          ...e,
          output: {
            reason: "other",
            hit_breakpoint_ids: ["bp_some_other_file"],
            call_stack: [],
          },
        };
      }
      return e;
    });
    const out = nodeStdioBug.oracle(
      trace,
      "stdio-bug.ts:12 — accumulate adds v+1.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/hit_breakpoint_ids/);
  });

  it("fails mechanic when no inspection happened after pause", () => {
    // Strip the get_scope call; the agent paused at the bp but never
    // looked at scope or stack or evaluated an expression.
    const trace = fullySuccessfulTrace().filter(
      (e) => !((e.t === "tool_call" || e.t === "tool_result") && e.toolUseId === "5"),
    );
    const out = nodeStdioBug.oracle(
      trace,
      "stdio-bug.ts:12 — `accumulate` adds v+1.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful inspection/);
  });

  it("fails mechanic when get_node_output returned but items has no stdout 'total:' line (called before flush)", () => {
    // Agent called get_node_output while paused inside accumulate — stdout
    // hasn't flushed yet, so items is empty (or only stderr inspector banner).
    const trace: TraceEntry[] = fullySuccessfulTrace().map((e) => {
      if (e.t === "tool_result" && e.toolUseId === "7") {
        return {
          ...e,
          output: {
            cursor: 2,
            items: [
              { seq: 1, ts: "x", stream: "stderr", text: "Debugger listening on ws://...\n" },
              { seq: 2, ts: "x", stream: "stderr", text: "Debugger attached.\n" },
            ],
          },
        };
      }
      return e;
    });
    const out = nodeStdioBug.oracle(
      trace,
      "stdio-bug.ts:12 — accumulate adds v+1.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/raw stdout never observed/);
  });

  it("fails mechanic when inspection happened ONLY during the entry pause (before bp hit)", () => {
    // Pre-bp get_scope during entry pause — successful, but no inspection
    // after the bp_1 hit.
    const trace: TraceEntry[] = [
      ...pair("1", "launch_node", { script: "x" }, { targetId: "T1" }),
      ...pair("2", "get_scope", {}, { items: [] }), // during entry pause — succeeds
      ...pair(
        "3",
        "set_breakpoint",
        { file: "stdio-bug.ts", line: 12 },
        { id: "bp_1" },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp_1"], call_stack: [] },
      ),
      // No inspection after the bp_1 hit.
      ...pair("6", "resume", {}, "resumed"),
      ...pair("7", "get_node_output", {}, {
        cursor: 1,
        items: [{ seq: 1, ts: "x", stream: "stdout", text: "total: 20\n" }],
      }),
    ];
    const out = nodeStdioBug.oracle(
      trace,
      "stdio-bug.ts:12 — accumulate adds v+1.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails correctness when the answer doesn't name stdio-bug.ts", () => {
    const trace = fullySuccessfulTrace();
    const out = nodeStdioBug.oracle(
      trace,
      "The accumulator is wrong — it adds an extra +1 per element.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/does not mention stdio-bug.ts/);
  });

  it("fails correctness when the answer names the file but not the line or bug fact", () => {
    const trace = fullySuccessfulTrace();
    const out = nodeStdioBug.oracle(
      trace,
      "Something is wrong in stdio-bug.ts but I can't pinpoint the exact issue.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/not the line/);
  });

  it("passes correctness when the answer names `accumulate` symbol or `+1` bug fact without a line number", () => {
    const trace = fullySuccessfulTrace();
    const noLineSymbol = nodeStdioBug.oracle(
      trace,
      "Bug is in stdio-bug.ts inside `accumulate` — the loop adds the wrong amount.",
    );
    expect(noLineSymbol.correctness).toBe(1);

    const noLineFact = nodeStdioBug.oracle(
      trace,
      "Bug is in stdio-bug.ts — there's an off-by-one in the loop body.",
    );
    expect(noLineFact.correctness).toBe(1);
  });
});
