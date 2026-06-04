// Scenario: compute-step — the canonical "find the off-by-one bug"
// scenario. The sample-app's `computeStep()` returns 2 instead of 1,
// so each click of #go adds 2 to the displayed count. The agent should:
//
//   launch_chrome → navigate → list_scripts (optional) → set_breakpoint
//   (handlers.ts:6, 7, 8, 11, or 12) → click #go → wait_for_pause →
//   get_call_stack / get_scope / evaluate → final answer naming
//   handlers.ts:12 (the literal `return 2` line) or computeStep.
//
// This is the load-bearing first scenario — its oracle is the most
// permissive of the 8 (we want to verify the agent can complete the
// flow at all, not constrain HOW it does so).

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify the basic breakpoint / pause / inspect cycle on a TypeScript source line. The page has a "Go" button that should add 1 to a counter per click — it adds 2. Set a TS-source breakpoint in the click-handler path, drive the page to trigger it, observe the pause, and inspect the paused state to identify the offending computation. Report the bug as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — did the agent exercise the debugger workflow?
  const handlerBp = calls.find(
    (c) =>
      c.tool === "set_breakpoint" &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("handlers.ts"),
  );
  const breakpointOk = !!handlerBp;

  const waitedAndPaused = calls.some(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      "reason" in (c.output as Record<string, unknown>),
  );

  const inspected = calls.some((c) =>
    ["get_call_stack", "get_scope", "evaluate", "get_object_properties"].includes(c.tool),
  );

  const mechanic: 0 | 1 = breakpointOk && waitedAndPaused && inspected ? 1 : 0;

  // CORRECTNESS check — does the final answer name the bug?
  const fa = finalAnswer.toLowerCase();
  const mentionsHandlersFile = /handlers\.ts/i.test(finalAnswer);
  const mentionsBugLine = /\b1[12]\b/.test(finalAnswer); // line 11 (function decl) or 12 (return)
  const mentionsBugSymbol = /computestep|return\s*2/i.test(fa);
  const correctness: 0 | 1 =
    mentionsHandlersFile && (mentionsBugLine || mentionsBugSymbol) ? 1 : 0;

  const why: string[] = [];
  if (!breakpointOk) why.push("mechanic: no set_breakpoint on handlers.ts");
  if (!waitedAndPaused) why.push("mechanic: wait_for_pause never returned a pause");
  if (!inspected) why.push("mechanic: no inspection after pause");
  if (!mentionsHandlersFile) why.push("correctness: final answer does not mention handlers.ts");
  if (!mentionsBugLine && !mentionsBugSymbol)
    why.push("correctness: final answer does not name the bug line (12) or function (computeStep)");

  const summary = `compute-step correctness=${correctness} mechanic=${mechanic}`;
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

export const computeStep: Scenario = {
  name: "compute-step",
  variantDir: "examples/sample-app/dist",
  prompt: PROMPT,
  oracle,
  // attach_chrome (or launch_chrome) + navigate + set_breakpoint + click +
  // wait_for_pause + get_call_stack (or get_scope) + resume = 7. Efficiency
  // floor — agents that take fewer than ~7 calls are unusually terse.
  oracleMinimumToolCalls: 7,
};
