import { describe, it, expect } from "vitest";
import { nodeConditionalBp } from "./node-conditional-bp.js";
import { pair } from "./_test-helpers.js";

describe("node-conditional-bp oracle", () => {
  const ANSWER =
    "Bug in conditional-bp.ts: processIteration returns i * 10 on the third iteration (i === 3) instead of i. The buggy branch is on line 9.";

  it("passes when the agent used a conditional breakpoint that the debugger honored", () => {
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair("2", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: [], call_stack: [] }),
      ...pair(
        "3",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1, resolved_locations: [] },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [{ file: "conditional-bp.ts", line: 16 }] },
      ),
      ...pair("6", "evaluate", { expression: "i" }, { type: "number", value: 3 }),
      ...pair("7", "resume", {}, "resumed"),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("fails mechanic when set_breakpoint lacks a condition (load-bearing rejection)", () => {
    // Agent set an UNCONDITIONAL bp, hit it, and inspected — but without
    // `condition` the Node surface has no way to halt only on the buggy
    // iteration. Correctness can still be 1 (the agent named the bug),
    // but mechanic must be 0.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair("2", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: [], call_stack: [] }),
      ...pair(
        "3",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16 }, // NO condition field
        { id: "bp1", status: "set", binding_count: 1, resolved_locations: [] },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [{ file: "conditional-bp.ts", line: 16 }] },
      ),
      ...pair("6", "evaluate", { expression: "i" }, { type: "number", value: 3 }),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when bp set with condition but wait_for_pause never fired the bp (empty hit_breakpoint_ids)", () => {
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      // Pause with empty hit_breakpoint_ids — e.g. agent timed out / paused
      // for some other reason that doesn't reference our conditional bp.
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair("5", "get_scope", {}, { items: [] }),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when hit_breakpoint_ids carries a DIFFERENT id than the conditional bp", () => {
    // Agent set a conditional bp but the pause that came through was tied
    // to a different bp (e.g. an unconditional bp added later). The
    // conditional one was never actually honored.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp-conditional", status: "set", binding_count: 1 },
      ),
      ...pair(
        "3",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 7 }, // unconditional fallback
        { id: "bp-unconditional", status: "set", binding_count: 1 },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        {},
        {
          reason: "other",
          hit_breakpoint_ids: ["bp-unconditional"], // NOT the conditional one
          call_stack: [{ file: "conditional-bp.ts", line: 7 }],
        },
      ),
      ...pair("6", "get_scope", {}, { items: [] }),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when bp + hit are both fine but the agent never inspected", () => {
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [{ file: "conditional-bp.ts", line: 16 }] },
      ),
      // No get_call_stack / get_scope / evaluate.
      ...pair("5", "resume", {}, "resumed"),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when condition is non-empty but does not narrow the loop (`true`)", () => {
    // condition: "true" — non-empty but fires on every iteration. Agent could
    // pause on i=0, see i=0 in scope, never observe i=3. Mechanic must reject.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "true" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      // Agent inspects, but scope shows i=0 (first iteration), not i=3.
      ...pair("5", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "0" }],
      }),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "Bug in conditional-bp.ts: processIteration returns i * 10 on the third iteration (i === 3). Line 9.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when condition is whitespace-only (passes truthy length check but is effectively unconditional)", () => {
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "   " },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("5", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "3" }],
      }),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "Bug in conditional-bp.ts: processIteration returns i * 10 on i === 3. Line 9.",
    );
    // usedConditionalBp now fails the .trim().length > 0 check.
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when the conditional bp is on line 9 (inside the `if (i === 3)` branch, condition decorative)", () => {
    // Codex P1 (re-review): a bp on line 9 fires only when i===3 because
    // the `if (i === 3) { return i * 10 }` branch already gates control
    // flow there — the condition does no narrowing work. The line gate
    // rejects so the condition has to be load-bearing.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 9, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("5", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "3" }],
      }),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    // bp1 isn't in conditionalBpIds (line 9 rejected), so the bp-hit gate
    // also fails. Both cascade failures are expressed via the
    // usedConditionalBp + bpHit messages in notes.
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/outside the .if \(i === 3\). branch/);
  });

  it("fails mechanic when the conditional bp is on line 10 (closing brace of the i===3 branch)", () => {
    // Same anti-pattern as line 9 — closing brace of the branch is still
    // control-flow-gated to i===3 only.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 10, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("5", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "3" }],
      }),
    ];
    const out = nodeConditionalBp.oracle(trace, ANSWER);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when `condition: \"true\"` and agent resumes past i=0,1,2 without inspecting (first-hit window empty)", () => {
    // Codex P1 (re-review): a `condition: "true"` bp fires every iteration.
    // If the agent never inspects on the first hit (i=0), then resumes
    // through i=1, i=2 until i===3 happens to land and only inspects
    // there, the condition wasn't doing any narrowing — V8 paused 4
    // times when it should have paused once. The first-hit window check
    // catches this: window between bpHitIdx (first wait_for_pause with
    // bp1) and the next resume contains no inspection.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "true" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      // First hit: i=0. Agent doesn't inspect — just resumes.
      ...pair("4", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] }),
      ...pair("5", "resume", {}, "resumed"),
      // Second hit: i=1. Same.
      ...pair("6", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] }),
      ...pair("7", "resume", {}, "resumed"),
      // Third hit: i=2.
      ...pair("8", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] }),
      ...pair("9", "resume", {}, "resumed"),
      // Fourth hit: i=3. NOW the agent inspects (too late — window check
      // looks only at the FIRST hit's window).
      ...pair("10", "wait_for_pause", {}, { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] }),
      ...pair("11", "get_scope", {}, { items: [{ name: "i", type: "number", preview: "3" }] }),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "Bug in conditional-bp.ts: processIteration returns i * 10 on the third iteration (i === 3). Line 9.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/FIRST bp-hit pause did not prove i===3/);
  });

  it("passes when scope confirms i=3 even without an explicit evaluate('i') call", () => {
    // The original PR smoke's actual path — agent did get_scope (showing i=3)
    // then evaluate("i * 10") (showing 30). Without an explicit evaluate("i"),
    // the scope path must be sufficient.
    const trace = [
      ...pair("1", "launch_node", { script: "x.js" }, { targetId: "T1", url: "file:///x" }),
      ...pair(
        "2",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 8, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair("3", "resume", {}, "resumed"),
      ...pair(
        "4",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("5", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "3" }],
      }),
      ...pair(
        "6",
        "evaluate",
        { expression: "i * 10" },
        { type: "number", value: 30 },
      ),
      ...pair("7", "resume", {}, "resumed"),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "Bug in conditional-bp.ts: processIteration returns i * 10 on the third iteration (i === 3). Line 9.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("rejects `i == 30` as a false-positive trigger match (was a bug caught in upstream review)", () => {
    const trace = [
      ...pair(
        "1",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1" },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("3", "get_scope", {}, {
        items: [{ name: "i", type: "number", preview: "3" }],
      }),
    ];
    // Answer references "i == 30" (e.g., the i*10 result). The previous regex
    // would false-positive on the "i == 3" prefix.
    const out = nodeConditionalBp.oracle(
      trace,
      "Bug in conditional-bp.ts: when i == 30 something weird happens.",
    );
    expect(out.correctness).toBe(0); // doesn't mention the actual trigger (i === 3 or third iteration)
  });

  it("fails correctness when the answer doesn't mention conditional-bp.ts", () => {
    const trace = [
      ...pair(
        "1",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("3", "evaluate", {}, {}),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "processIteration returns i * 10 instead of i when i === 3.",
    );
    expect(out.correctness).toBe(0);
  });

  it("fails correctness when the answer names the file but not the trigger", () => {
    const trace = [
      ...pair(
        "1",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("3", "evaluate", {}, {}),
    ];
    const out = nodeConditionalBp.oracle(trace, "There is a bug in conditional-bp.ts.");
    expect(out.correctness).toBe(0);
  });

  it("fails correctness when the answer identifies the trigger but not the bug fact", () => {
    const trace = [
      ...pair(
        "1",
        "set_breakpoint",
        { file: "conditional-bp.ts", line: 16, condition: "i === 3" },
        { id: "bp1", status: "set", binding_count: 1 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        {},
        { reason: "other", hit_breakpoint_ids: ["bp1"], call_stack: [] },
      ),
      ...pair("3", "evaluate", {}, {}),
    ];
    const out = nodeConditionalBp.oracle(
      trace,
      "conditional-bp.ts: the bug fires on i === 3 but the exact wrong behavior is unclear.",
    );
    expect(out.correctness).toBe(0);
  });
});
