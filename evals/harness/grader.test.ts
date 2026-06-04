// Unit tests for the grader — synthetic traces feed gradeTrial,
// rollupScenario, renderScoreboard. No API calls, no MCP server, no
// filesystem.

import { describe, it, expect } from "vitest";
import { gradeTrial, rollupScenario, renderScoreboard } from "./grader.js";
import type {
  OracleResult,
  Scenario,
  TraceEntry,
  TrialOutcome,
} from "./types.js";

function scenario(
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    name: "test-scenario",
    variantDir: "irrelevant",
    prompt: "prompt",
    oracle: (): OracleResult => ({
      correctness: 1,
      mechanic: 1,
      efficiency: 0,
      recovery: 0,
      notes: "stub",
    }),
    oracleMinimumToolCalls: 4,
    ...overrides,
  };
}

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

describe("gradeTrial", () => {
  it("propagates the oracle's correctness verdict", () => {
    const sc = scenario({
      oracle: () => ({ correctness: 1, mechanic: 1, efficiency: 0, recovery: 0, notes: "ok" }),
    });
    const out = gradeTrial(sc, [], "answer");
    expect(out.correctness).toBe(1);
    expect(out.notes).toBe("ok");
  });

  it("computes efficiency from oracleMinimumToolCalls when the oracle leaves it 0", () => {
    const sc = scenario({ oracleMinimumToolCalls: 4 });
    const trace: TraceEntry[] = [
      call("1", "a", {}),
      result("1", "a", false, {}),
      call("2", "b", {}),
      result("2", "b", false, {}),
      call("3", "c", {}),
      result("3", "c", false, {}),
      call("4", "d", {}),
      result("4", "d", false, {}),
      call("5", "e", {}),
      result("5", "e", false, {}),
      call("6", "f", {}),
      result("6", "f", false, {}),
      call("7", "g", {}),
      result("7", "g", false, {}),
      call("8", "h", {}),
      result("8", "h", false, {}),
    ];
    // 8 tool calls, oracle minimum 4 → efficiency = 4/8 = 0.5.
    const out = gradeTrial(sc, trace, "");
    expect(out.efficiency).toBeCloseTo(0.5, 5);
  });

  it("caps efficiency at 1.0 even when the agent under-shoots the floor", () => {
    const sc = scenario({ oracleMinimumToolCalls: 10 });
    // Only 3 tool calls — well below the floor of 10. Capped at 1.0
    // (extra-fast runs don't get credit because the oracle minimum
    // isn't tight enough to validate the work was actually done).
    const trace: TraceEntry[] = [
      call("1", "a", {}),
      result("1", "a", false, {}),
      call("2", "b", {}),
      result("2", "b", false, {}),
      call("3", "c", {}),
      result("3", "c", false, {}),
    ];
    const out = gradeTrial(sc, trace, "");
    expect(out.efficiency).toBe(1);
  });

  it("counts a recovery when the next call uses a different tool after an error", () => {
    const trace: TraceEntry[] = [
      call("1", "get_call_stack", {}),
      result("1", "get_call_stack", true, { error: "not_paused" }, "not_paused"),
      // recovery: next call is a different tool
      call("2", "set_breakpoint", { file: "x.ts", line: 1 }),
      result("2", "set_breakpoint", false, { id: "bp_1" }),
      call("3", "click", { selector: "#go" }),
      result("3", "click", true, { error: "not_found" }, "not_found"),
      // no follow-up — does NOT count as recovery
    ];
    const out = gradeTrial(scenario(), trace, "");
    expect(out.recovery).toBe(1);
  });

  it("does NOT count a recovery when the agent blindly retries the IDENTICAL call", () => {
    const trace: TraceEntry[] = [
      call("1", "set_breakpoint", { file: "x.ts", line: 999 }),
      result("1", "set_breakpoint", true, { error: "no_mapping" }, "no_mapping"),
      call("2", "set_breakpoint", { file: "x.ts", line: 999 }),
      result("2", "set_breakpoint", true, { error: "no_mapping" }, "no_mapping"),
    ];
    const out = gradeTrial(scenario(), trace, "");
    expect(out.recovery).toBe(0);
  });

  it("counts a recovery when the agent retries the same tool with corrected args (PR #15 review)", () => {
    // set_breakpoint failed on line 999, agent retried on line 12 — that's
    // a real recovery, not a blind retry. Pre-fix this returned 0.
    const trace: TraceEntry[] = [
      call("1", "set_breakpoint", { file: "x.ts", line: 999 }),
      result("1", "set_breakpoint", true, { error: "no_mapping" }, "no_mapping"),
      call("2", "set_breakpoint", { file: "x.ts", line: 12 }),
      result("2", "set_breakpoint", false, { id: "bp" }),
    ];
    const out = gradeTrial(scenario(), trace, "");
    expect(out.recovery).toBe(1);
  });

  it("respects overrideOracle for synthetic grading tests", () => {
    const out = gradeTrial(scenario(), [], "answer", {
      overrideOracle: () => ({ correctness: 0, mechanic: 0, efficiency: 1, recovery: 0, notes: "override" }),
    });
    expect(out.correctness).toBe(0);
    expect(out.notes).toBe("override");
  });
});

describe("rollupScenario", () => {
  function outcome(
    correctness: 0 | 1,
    costUsd = 1,
    efficiency = 1,
    mechanic: 0 | 1 = correctness,
  ): TrialOutcome {
    return {
      scenario: "s",
      trial: 0,
      oracle: { correctness, mechanic, efficiency, recovery: 0, notes: "" },
      elapsedMs: 100,
      costUsd,
      tracePath: "/tmp/x.ndjson",
    };
  }

  it("median over 3 trials passes when ≥2 trials passed", () => {
    expect(rollupScenario("s", [outcome(1), outcome(1), outcome(0)]).medianCorrectness).toBe(1);
    expect(rollupScenario("s", [outcome(1), outcome(0), outcome(0)]).medianCorrectness).toBe(0);
  });

  it("single-trial passes the gate iff that trial passed", () => {
    expect(rollupScenario("s", [outcome(1)]).medianCorrectness).toBe(1);
    expect(rollupScenario("s", [outcome(0)]).medianCorrectness).toBe(0);
  });

  it("sums cost and recoveries across trials", () => {
    const r = rollupScenario("s", [outcome(1, 0.5), outcome(1, 0.75), outcome(0, 1)]);
    expect(r.totalCostUsd).toBeCloseTo(2.25, 5);
    expect(r.trials).toBe(3);
  });

  it("renders a scoreboard with a total-cost footer", () => {
    const board = renderScoreboard([
      rollupScenario("compute-step", [outcome(1, 0.5), outcome(1, 0.5), outcome(1, 0.5)]),
      rollupScenario("network-bug", [outcome(0, 0.3), outcome(0, 0.3), outcome(1, 0.3)]),
    ]);
    expect(board).toContain("compute-step");
    expect(board).toContain("PASS");
    expect(board).toContain("FAIL");
    // Total = (3 * 0.5) + (3 * 0.3) = $2.40
    expect(board).toContain("$2.40");
  });
});

describe("rollupScenario — xfailCorrectness status", () => {
  function outcome(correctness: 0 | 1, costUsd = 1): TrialOutcome {
    return {
      scenario: "s",
      trial: 0,
      oracle: { correctness, mechanic: 1, efficiency: 1, recovery: 0, notes: "" },
      elapsedMs: 100,
      costUsd,
      tracePath: "/tmp/x.ndjson",
    };
  }

  it("untagged scenario → PASS when median correctness=1", () => {
    const r = rollupScenario("s", [outcome(1), outcome(1), outcome(0)]);
    expect(r.status).toBe("PASS");
    expect(r.xfailCorrectness).toBe(false);
  });

  it("untagged scenario → FAIL when median correctness=0", () => {
    const r = rollupScenario("s", [outcome(0), outcome(0), outcome(1)]);
    expect(r.status).toBe("FAIL");
    expect(r.xfailCorrectness).toBe(false);
  });

  it("xfail-tagged scenario → XFAIL when median correctness=0 (the expected outcome)", () => {
    const r = rollupScenario("s", [outcome(0), outcome(0), outcome(1)], {
      xfailCorrectness: true,
    });
    expect(r.status).toBe("XFAIL");
    expect(r.medianCorrectness).toBe(0);
    expect(r.xfailCorrectness).toBe(true);
  });

  it("xfail-tagged scenario → XPASS when median correctness=1 (unexpected pass)", () => {
    const r = rollupScenario("s", [outcome(1), outcome(1), outcome(0)], {
      xfailCorrectness: true,
    });
    expect(r.status).toBe("XPASS");
    expect(r.medianCorrectness).toBe(1);
    expect(r.xfailCorrectness).toBe(true);
  });

  it("scoreboard renders XFAIL and XPASS! status strings + footer counts", () => {
    const board = renderScoreboard([
      rollupScenario("compute-step", [outcome(1, 0.5), outcome(1, 0.5), outcome(1, 0.5)]),
      rollupScenario("adversarial", [outcome(0, 0.3), outcome(0, 0.3), outcome(0, 0.3)], {
        xfailCorrectness: true,
      }),
      rollupScenario("worker-bug", [outcome(1, 0.2), outcome(1, 0.2), outcome(0, 0.2)], {
        xfailCorrectness: true,
      }),
      rollupScenario("network-bug", [outcome(0, 0.4), outcome(0, 0.4), outcome(0, 0.4)]),
    ]);
    expect(board).toContain("XFAIL");
    expect(board).toContain("XPASS!");
    // Footer: 1 PASS, 1 XFAIL, 1 XPASS, 1 FAIL
    expect(board).toMatch(/1\/4 correct/);
    expect(board).toMatch(/1 xfail/);
    expect(board).toMatch(/1 XPASS!/);
    expect(board).toMatch(/1 fail/);
  });
});
