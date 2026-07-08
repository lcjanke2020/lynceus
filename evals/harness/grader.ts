// Programmatic oracle grading + aggregate scoring.
//
// Four axes (correctness + mechanic added as a dedicated bit in the
// 2026-05-16 SDET-framing rework — see plan & PR #12 measurement
// findings on the "lazy solver" pattern):
//   - correctness (0/1): the scenario's oracle predicate over finalAnswer.
//     Did the agent name the right bug? Independent of method.
//   - mechanic (0/1): did the agent exercise the debugger workflow the
//     scenario was built to test? E.g., set a breakpoint AND observe a
//     pause AND inspect, vs. solve by reading source alone.
//   - efficiency (0..1): tool_calls / oracleMinimum, capped at 1.0.
//   - recovery: count of distinct error codes the agent recovered from
//     (the next tool call differed from the failing one).
//
// All four are computable from the NDJSON trace alone — no LLM judge,
// no manual scoring. The oracle predicate itself lives in the scenario
// file (so per-scenario assertions stay close to the scenario's intent).

import type { OracleResult, Scenario, TraceEntry, TrialOutcome } from "./types.js";
import { toolPairs } from "./trace.js";

export interface GradeOpts {
  /** Override the scenario's oracle — for testing the grader against a
   *  synthetic trace with a known-good or known-bad oracle. */
  overrideOracle?: Scenario["oracle"];
}

export function gradeTrial(
  scenario: Scenario,
  trace: TraceEntry[],
  finalAnswer: string,
  opts: GradeOpts = {},
): OracleResult {
  const oracle = opts.overrideOracle ?? scenario.oracle;
  const base = oracle(trace, finalAnswer);

  // Recovery diagnostic — applied uniformly to every scenario. A
  // "recovery" is an erroring call followed by ANY change to the next
  // call: a different tool name, OR the same tool with different args
  // (e.g., set_breakpoint with a corrected line number after no_mapping).
  // PR #15 review: comparing tool name only under-reports the diagnostic
  // since same-tool-different-args is a common and valid recovery shape.
  const pairs = toolPairs(trace);
  const errorCodes = new Set<string>();
  let recoveredFromCount = 0;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.isError && p.errorCode) {
      errorCodes.add(p.errorCode);
      const next = pairs[i + 1];
      if (next) {
        const sameCall =
          next.tool === p.tool &&
          JSON.stringify(next.input) === JSON.stringify(p.input);
        if (!sameCall) {
          recoveredFromCount += 1;
        }
      }
    }
  }

  // Efficiency — already provided by oracle if it computed one; otherwise
  // derive from tool_call count. Oracles that don't compute efficiency
  // should return 0 (the sentinel), which the grader then back-fills.
  // 0 is treated as "not provided" because efficiency 0 alone is
  // uninformative: it overlaps with correctness=0 (the trial did nothing)
  // and no scenario legitimately wants to grade an action-rich run at 0.
  let efficiency = base.efficiency;
  if (efficiency === undefined || efficiency === 0 || Number.isNaN(efficiency)) {
    const toolCalls = pairs.length;
    if (scenario.oracleMinimumToolCalls > 0 && toolCalls > 0) {
      efficiency = Math.min(1, scenario.oracleMinimumToolCalls / toolCalls);
    } else {
      efficiency = 1;
    }
  }

  return {
    correctness: base.correctness,
    mechanic: base.mechanic,
    efficiency,
    recovery: recoveredFromCount,
    notes: base.notes,
  };
}

/** Per-scenario correctness status accounting for `xfailCorrectness`.
 *  Distinguishes design-intent failures from real failures so the CLI
 *  exit code and scoreboard can treat them differently.
 *
 *  - `PASS`  — correctness gate passed; scenario is not xfail-tagged.
 *  - `FAIL`  — correctness gate failed; scenario is not xfail-tagged.
 *            **This is the only status that fails the run.**
 *  - `XFAIL` — correctness gate failed; scenario IS xfail-tagged. The
 *            expected outcome — does not fail the run.
 *  - `XPASS` — correctness gate passed; scenario IS xfail-tagged. An
 *            unexpected pass; printed with a `(!)` marker so the
 *            operator can decide whether to drop the xfail tag, but
 *            does not fail the run. */
export type ScenarioStatus = "PASS" | "FAIL" | "XFAIL" | "XPASS";

export interface ScenarioRollup {
  scenario: string;
  trials: number;
  /** Median correctness — for 3 trials this is 0 (0 or 1 passes), 0.5
   *  (rounded to 0/1 below), or 1. The plan's gate is "median ≥ 2/3"
   *  which we encode as the median (passes if at least ceil(N/2) of N
   *  trials passed). */
  medianCorrectness: 0 | 1;
  /** Median mechanic — same shape as medianCorrectness but over the
   *  workflow-exercise bit. Tracks "did the model drive the debugger?"
   *  separately from "did the model find the bug?". */
  medianMechanic: 0 | 1;
  /** Correctness-axis status taking `xfailCorrectness` into account.
   *  This is what the CLI uses for its exit code and what the
   *  scoreboard prints in the CORRECT column. */
  status: ScenarioStatus;
  /** Mechanic-axis status taking `xfailMechanic` into account — the
   *  mechanic-column analog of `status`. PASS/FAIL when untagged;
   *  XFAIL/XPASS when the scenario is `xfailMechanic`-tagged. Unlike
   *  `status`, this never feeds the CLI exit code (mechanic is
   *  diagnostic-only). */
  mechanicStatus: ScenarioStatus;
  /** True if the scenario was tagged `xfailCorrectness` — preserved on
   *  the rollup so the scoreboard footer can count xfails separately. */
  xfailCorrectness: boolean;
  /** True if the scenario was tagged `xfailMechanic` — mirror of
   *  `xfailCorrectness` for the mechanic axis. */
  xfailMechanic: boolean;
  /** Per-trial details so the per-night report can show the breakdown. */
  per: TrialOutcome[];
  meanEfficiency: number;
  totalRecoveries: number;
  totalCostUsd: number;
}

export interface RollupOpts {
  /** Mirror of `Scenario.xfailCorrectness` — when true, the
   *  correctness-axis result is reported as XFAIL/XPASS rather than
   *  FAIL/PASS, and neither fails the run. */
  xfailCorrectness?: boolean;
  /** Mirror of `Scenario.xfailMechanic` — when true, the mechanic-axis
   *  result is reported as XFAIL/XPASS rather than FAIL/PASS. Display
   *  only; the mechanic axis never fails the run either way. */
  xfailMechanic?: boolean;
}

export function rollupScenario(
  scenarioName: string,
  outcomes: TrialOutcome[],
  opts: RollupOpts = {},
): ScenarioRollup {
  const passes = outcomes.filter((o) => o.oracle.correctness === 1).length;
  const medianCorrectness: 0 | 1 = passes >= Math.ceil(outcomes.length / 2) ? 1 : 0;
  const mechanicPasses = outcomes.filter((o) => o.oracle.mechanic === 1).length;
  const medianMechanic: 0 | 1 =
    mechanicPasses >= Math.ceil(outcomes.length / 2) ? 1 : 0;
  const meanEfficiency =
    outcomes.length === 0
      ? 0
      : outcomes.reduce((s, o) => s + o.oracle.efficiency, 0) / outcomes.length;
  const totalRecoveries = outcomes.reduce((s, o) => s + o.oracle.recovery, 0);
  const totalCostUsd = outcomes.reduce((s, o) => s + o.costUsd, 0);
  const xfailCorrectness = opts.xfailCorrectness === true;
  const status: ScenarioStatus = xfailCorrectness
    ? medianCorrectness === 1
      ? "XPASS"
      : "XFAIL"
    : medianCorrectness === 1
      ? "PASS"
      : "FAIL";
  const xfailMechanic = opts.xfailMechanic === true;
  const mechanicStatus: ScenarioStatus = xfailMechanic
    ? medianMechanic === 1
      ? "XPASS"
      : "XFAIL"
    : medianMechanic === 1
      ? "PASS"
      : "FAIL";
  return {
    scenario: scenarioName,
    trials: outcomes.length,
    medianCorrectness,
    medianMechanic,
    status,
    mechanicStatus,
    xfailCorrectness,
    xfailMechanic,
    per: outcomes,
    meanEfficiency,
    totalRecoveries,
    totalCostUsd,
  };
}

/** Render a scoreboard like:
 *
 *    SCENARIO              TRIALS  CORRECT  MECHANIC  EFFICIENCY  RECOVERIES  COST
 *    compute-step            3       PASS     PASS        0.83          0    $1.85
 *    network-bug             3       FAIL     PASS        0.40          1    $1.71
 *    adversarial-out-...     3      XFAIL   XPASS!        0.67          0    $1.50
 *    ...                                                                     -----
 *                                                                            $14.32
 *
 *  (adversarial-out-... is xfail-tagged on BOTH axes, so its CORRECT and
 *  MECHANIC columns render XFAIL/XPASS! independently — here it missed the
 *  bug under degraded guidance (XFAIL) but still drove the debugger (XPASS!).)
 *
 *  CORRECT column shows the xfail-aware status (PASS / FAIL / XFAIL /
 *  XPASS!). MECHANIC shows the same xfail-aware status for the mechanic
 *  axis (`xfailMechanic`-tagged scenarios render XFAIL/XPASS!); it stays
 *  independent of CORRECT by design (a scenario can drive the debugger
 *  correctly while misidentifying the bug, or vice versa). Only FAIL in
 *  the CORRECT column fails the run — the MECHANIC column is
 *  diagnostic-only and never gates. XPASS gets a `!` marker in either
 *  column to flag that a tagged axis passed — an unexpected pass for a
 *  `xfailCorrectness` tag (consider dropping it), or the intended bonus
 *  for a defensive `xfailMechanic` tag.
 */
export function renderScoreboard(rollups: ScenarioRollup[]): string {
  const rows: string[] = [];
  rows.push(
    "SCENARIO".padEnd(28) +
      "TRIALS".padStart(7) +
      "CORRECT".padStart(9) +
      "MECHANIC".padStart(10) +
      "EFFICIENCY".padStart(12) +
      "RECOVERIES".padStart(12) +
      "COST".padStart(10),
  );
  rows.push("-".repeat(88));
  let totalCost = 0;
  let passedScenarios = 0; // PASS only — what the CI gate cares about
  let xfailCount = 0;
  let xpassCount = 0;
  let failCount = 0;
  let mechanicPassed = 0;
  for (const r of rollups) {
    totalCost += r.totalCostUsd;
    if (r.status === "PASS") passedScenarios += 1;
    else if (r.status === "XFAIL") xfailCount += 1;
    else if (r.status === "XPASS") xpassCount += 1;
    else if (r.status === "FAIL") failCount += 1;
    // Deliberately asymmetric with `passedScenarios`: this counts every
    // scenario that drove the debugger (`medianMechanic === 1`), so a
    // MECHANIC-column `XPASS!` (xfailMechanic-tagged but the flow ran) counts
    // here, whereas a correctness `XPASS!` is excluded from `passedScenarios`.
    // The mechanic axis is diagnostic-only, so "did it drive the debugger" is
    // the useful tally regardless of the xfail tag.
    if (r.medianMechanic === 1) mechanicPassed += 1;
    const correctDisplay = r.status === "XPASS" ? "XPASS!" : r.status;
    const mechanicDisplay = r.mechanicStatus === "XPASS" ? "XPASS!" : r.mechanicStatus;
    rows.push(
      r.scenario.padEnd(28) +
        String(r.trials).padStart(7) +
        correctDisplay.padStart(9) +
        mechanicDisplay.padStart(10) +
        r.meanEfficiency.toFixed(2).padStart(12) +
        String(r.totalRecoveries).padStart(12) +
        ("$" + r.totalCostUsd.toFixed(2)).padStart(10),
    );
  }
  rows.push("-".repeat(88));
  const parts: string[] = [];
  // The xfail/XPASS!/fail breakdown is correctness-axis only, so group it in
  // parens under the `correct` count — since `xfailMechanic` landed, XFAIL/
  // XPASS can also appear in the MECHANIC column, and an unqualified
  // `1 xfail` in the footer would read ambiguously across both axes.
  const correctBreakdown: string[] = [];
  if (xfailCount > 0) correctBreakdown.push(`${xfailCount} xfail`);
  if (xpassCount > 0) correctBreakdown.push(`${xpassCount} XPASS!`);
  if (failCount > 0) correctBreakdown.push(`${failCount} fail`);
  parts.push(
    `${passedScenarios}/${rollups.length} correct` +
      (correctBreakdown.length ? ` (${correctBreakdown.join(", ")})` : ""),
  );
  parts.push(`${mechanicPassed}/${rollups.length} mechanic`);
  rows.push(parts.join(", ").padEnd(78) + ("$" + totalCost.toFixed(2)).padStart(10));
  return rows.join("\n");
}
