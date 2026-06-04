// Scenario: conditional-bp — variant's bug only manifests on the third
// click.
//
// The first two clicks increment by 1 (correct). The third and
// subsequent clicks increment by 2. The agent that pauses on every
// click and inspects scope hand-by-hand will eventually find it, but
// an *efficient* agent recognizes the pattern and sets a CONDITIONAL
// breakpoint that only fires when the buggy code path activates.
//
// Plan rev 6: "Oracle: trace contains set_breakpoint with a condition:
// 'count >= ...' rather than spamming step." We're more permissive —
// either a condition-breakpoint OR multiple clicks-then-pause cycles
// count as "solved", but the efficiency floor (oracleMinimumToolCalls)
// rewards the elegant approach.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify conditional breakpoints (and as fallback, repeated-click pause loops). The counter behaves correctly for the first two clicks; the third and subsequent clicks jump by 2. Set a conditional breakpoint using the \`condition\` parameter on set_breakpoint to halt only on the buggy iteration — or click enough times to observe the bug empirically. Pause, inspect, and report what's special about the third click as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent reached the bug via the debugger workflow.
  const usedConditionalBp = calls.some(
    (c) =>
      c.tool === "set_breakpoint" &&
      typeof c.input === "object" &&
      c.input !== null &&
      typeof (c.input as { condition?: unknown }).condition === "string" &&
      ((c.input as { condition: string }).condition.length ?? 0) > 0,
  );
  const clickCount = calls.filter((c) => c.tool === "click").length;
  const clickedAtLeast3Times = clickCount >= 3;
  const reachedTheBug = usedConditionalBp || clickedAtLeast3Times;

  const sawPause = calls.some(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null,
  );
  const inspected = calls.some((c) =>
    ["get_call_stack", "get_scope", "evaluate"].includes(c.tool),
  );
  const mechanic: 0 | 1 = reachedTheBug && sawPause && inspected ? 1 : 0;

  // CORRECTNESS checks — answer names the conditional trigger.
  const fa = finalAnswer.toLowerCase();
  const mentionsHandlers = /handlers\.ts/i.test(finalAnswer);
  const mentionsTrigger = /third|3rd|\bcount\s*[>=]+\s*2\b|threshold|after\s+2/i.test(fa);
  const correctness: 0 | 1 = mentionsHandlers && mentionsTrigger ? 1 : 0;

  const why: string[] = [];
  if (!reachedTheBug)
    why.push("mechanic: agent neither used a conditional breakpoint nor clicked ≥3 times");
  if (!sawPause) why.push("mechanic: no pause observed");
  if (!inspected) why.push("mechanic: no inspection after pause");
  if (!mentionsHandlers) why.push("correctness: answer doesn't mention handlers.ts");
  if (!mentionsTrigger) why.push("correctness: answer doesn't describe the third-click trigger");

  const summary = `conditional-bp correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved (${usedConditionalBp ? "conditional bp" : `${clickCount} clicks`})`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const conditionalBp: Scenario = {
  name: "conditional-bp",
  variantDir: "evals/sample-app-variants/conditional-bp/dist",
  prompt: PROMPT,
  oracle,
  // Conditional-bp approach: launch_chrome, navigate, set_breakpoint
  // (with condition), click ×3, wait_for_pause, get_scope, resume = ~7.
  // Brute-force approach: launch, navigate, set_breakpoint, click,
  // wait, resume, click, wait, resume, click, wait, get_scope ≈ 12+.
  // Floor at 7 so the elegant approach scores 1.0.
  oracleMinimumToolCalls: 7,
};
