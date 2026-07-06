// Scenario: node-compute-step — Node port of compute-step. The
// sample-node-app's `computeStep()` returns 2 instead of 1, so each
// call from `tick()` adds 2 to the running counter (frame chain
// main() -> tick() -> computeStep()). The agent should:
//
//   launch_node (the entry pause from --inspect-brk is already active
//   when the call returns) -> set_breakpoint (compute-step.ts:7 — the
//   `step = 2` line — or anywhere in the computeStep / tick chain) ->
//   resume -> wait_for_pause -> get_call_stack / get_scope / evaluate
//   -> resume -> final answer naming compute-step.ts:7 or computeStep.
//
// Why we key off `hit_breakpoint_ids` rather than wait_for_pause.reason:
// V8 emits non-standard reason strings on Node ("Break on start" for the
// --inspect-brk entry pause is the canonical example, but the bp-hit
// reason is also vendor-shaped), so the only reliable signal that a bp
// we set actually fired is the id appearing in the pause's
// hit_breakpoint_ids array. See test/e2e/node-breakpoint-flow.e2e.test.ts.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify the basic breakpoint / pause / inspect cycle on a Node TypeScript script. The script ticks a counter via tick() calling computeStep(); each tick should add 1 to the counter but adds 2. Set a TS-source breakpoint in the tick / computeStep path, drive the script past its entry pause, observe a pause on your breakpoint, and inspect the paused state to identify the offending computation. Report the bug as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // Collect every successful set_breakpoint id that landed on compute-step.ts.
  const bpIdsOnComputeStep = new Set<string>();
  for (const c of calls) {
    if (
      c.tool === "set_breakpoint" &&
      !c.isError &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("compute-step.ts") &&
      typeof c.output === "object" &&
      c.output !== null
    ) {
      const id = (c.output as { id?: unknown }).id;
      if (typeof id === "string") bpIdsOnComputeStep.add(id);
    }
  }
  const breakpointOk = bpIdsOnComputeStep.size > 0;

  // Index of the first wait_for_pause whose hit_breakpoint_ids contains one of our bp ids.
  // This is the canonical Node check — V8's reason strings on Node are
  // not standard, so we never compare on reason; only id-membership is
  // reliable. The entry pause from --inspect-brk has empty
  // hit_breakpoint_ids, which correctly fails this predicate.
  const bpHitIdx = calls.findIndex(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      Array.isArray((c.output as { hit_breakpoint_ids?: unknown }).hit_breakpoint_ids) &&
      ((c.output as { hit_breakpoint_ids: unknown[] }).hit_breakpoint_ids as unknown[]).some(
        (id) => typeof id === "string" && bpIdsOnComputeStep.has(id),
      ),
  );
  const bpHit = bpHitIdx >= 0;

  // Successful inspection AFTER the bp-hit pause. Pre-pause inspections (which
  // would fail with not_paused) and inspections during the entry pause (before
  // any user bp fired) don't count — model on evals/scenarios/worker-bug.ts:65-77.
  const inspectedAfterBpHit =
    bpHit &&
    calls
      .slice(bpHitIdx + 1)
      .some(
        (c) =>
          !c.isError &&
          ["get_call_stack", "get_scope", "evaluate"].includes(c.tool),
      );

  const mechanic: 0 | 1 = breakpointOk && bpHit && inspectedAfterBpHit ? 1 : 0;

  // CORRECTNESS — final answer mentions compute-step.ts AND (line 7 OR
  // the `computeStep` symbol OR a `step = 2` / `return 2` snippet).
  const fa = finalAnswer.toLowerCase();
  const mentionsFile = /compute-step\.ts/i.test(finalAnswer);
  const mentionsBugLine = /\b7\b/.test(finalAnswer);
  const mentionsBugSymbol = /computestep|step\s*=\s*2|return\s*2/i.test(fa);
  const correctness: 0 | 1 =
    mentionsFile && (mentionsBugLine || mentionsBugSymbol) ? 1 : 0;

  const why: string[] = [];
  if (!breakpointOk) why.push("mechanic: no set_breakpoint on compute-step.ts");
  if (!bpHit)
    why.push(
      "mechanic: no wait_for_pause whose hit_breakpoint_ids includes a bp set on compute-step.ts",
    );
  if (!inspectedAfterBpHit) why.push("mechanic: no successful inspection after the bp-hit pause");
  if (!mentionsFile) why.push("correctness: final answer does not mention compute-step.ts");
  if (!mentionsBugLine && !mentionsBugSymbol)
    why.push("correctness: final answer does not name the bug line (7) or function (computeStep)");

  const summary = `node-compute-step correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0, // grader will derive from oracleMinimumToolCalls
    recovery: 0, // grader will compute
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — bug named + breakpoint/pause/inspect cycle exercised`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const nodeComputeStep: Scenario = {
  name: "node-compute-step",
  target: { kind: "node", script: "examples/sample-node-app/dist/compute-step.js" },
  prompt: PROMPT,
  oracle,
  // launch_node + wait_for_pause (entry pause drain) + set_breakpoint +
  // resume + wait_for_pause (bp hit) + one inspect + close_session = 7.
  // Aligns with NODE_SYSTEM_PROMPT step 2 (entry-pause drain). Efficiency
  // floor — agents that take fewer than ~7 calls have likely skipped a step.
  oracleMinimumToolCalls: 7,
};
