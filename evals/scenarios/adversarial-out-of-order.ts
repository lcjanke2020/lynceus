// Scenario: adversarial-out-of-order — the compute-step bug + a
// deliberately-stripped system prompt.
//
// Per plan rev 6 → L4 → Scenarios: "Stock variant, system prompt
// deliberately omits the 'set_breakpoint then wait_for_pause then click'
// guidance. Oracle: agent calls something like get_call_stack first
// (gets not_paused), recovers, completes within 15 tool calls."
//
// The purpose is to test the agent's *recovery* under degraded guidance.
// We expect the agent to attempt a pause-only tool while not paused,
// receive an error envelope, and figure out the right ordering from
// the error message. The oracle gates correctness on: (a) the agent
// eventually solved compute-step, AND (b) ≤ 15 tool calls total. Whether
// the agent actually erred and recovered is captured as a diagnostic
// note + the grader's `recovery` axis — not gated on, since a clean
// solve under degraded guidance is a legitimate (if surprising) pass
// rather than a failure (PR #15 review).
//
// LEO-400: the task prompt now demands a *runtime* confirmation ("pause
// where the value is computed") so a capable model can't satisfy the
// scenario by static source-reading alone. It deliberately does NOT
// prescribe the tool ordering (that lives in the system prompt this
// scenario strips), so the out-of-order recovery challenge survives and
// this does not collapse into compute-step. The mechanic axis is also
// `xfailMechanic`-tagged: the bug (`return 2`) is trivially readable in
// source, so the breakpoint→pause flow cannot be *forced* by
// construction — a compliant run reports XPASS! (bonus, model drove the
// debugger), a legitimate static shortcut reports XFAIL (tolerated),
// rather than a nagging FAIL.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `The page has a button labeled "Go" that should increment a counter by 1 per click. It's adding 2 instead. Reading the source isn't enough to be sure — pause execution where the increment is computed and confirm the wrong value at runtime before answering. End your answer with the file:line.`;

const MINIMAL_SYSTEM = `You are an AI debugging assistant connected to a Chrome DevTools Protocol MCP server. Tools are exposed; pick any that help. Investigate the page, find the bug, and report the file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent eventually solves through the debugger (under
  // degraded system-prompt guidance) within a tool-call budget.
  const sawBreakpoint = calls.some(
    (c) =>
      c.tool === "set_breakpoint" &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("handlers.ts"),
  );
  const sawPause = calls.some(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null,
  );
  // Efficiency cap — plan rev 6 specifies ≤ 15 tool calls. Above that,
  // the agent didn't really "recover" — it brute-forced. Belongs to
  // mechanic (HOW the agent solved) not correctness (DID it find the bug).
  const efficient = calls.length <= 15;
  const mechanic: 0 | 1 = sawBreakpoint && sawPause && efficient ? 1 : 0;

  // CORRECTNESS checks — final answer names the bug.
  const mentionsHandlers = /handlers\.ts/i.test(finalAnswer);
  const mentionsBug = /\b1[12]\b|computestep|return\s*2/i.test(finalAnswer);
  const correctness: 0 | 1 = mentionsHandlers && mentionsBug ? 1 : 0;

  // Diagnostic-only: did the agent err at least once before solving?
  const sawError = calls.some((c) => c.isError);
  const recoveryNote = sawError ? "with recovery from error" : "no errors observed (clean solve)";

  const why: string[] = [];
  if (!sawBreakpoint) why.push("mechanic: no set_breakpoint on handlers.ts");
  if (!sawPause) why.push("mechanic: never observed a pause");
  if (!efficient) why.push(`mechanic: ${calls.length} tool calls > 15 efficiency cap`);
  if (!mentionsHandlers) why.push("correctness: answer does not mention handlers.ts");
  if (!mentionsBug) why.push("correctness: answer does not name the bug line/function");

  const summary = `adversarial-out-of-order correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved (${calls.length} tool calls, ${recoveryNote})`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const adversarialOutOfOrder: Scenario = {
  name: "adversarial-out-of-order",
  // Uses the canonical bug — same dist as compute-step.
  variantDir: "examples/sample-app/dist",
  prompt: PROMPT,
  systemPromptOverride: MINIMAL_SYSTEM,
  oracle,
  // We expect MORE calls than compute-step (recovery from wrong-order
  // attempts). Cap at 15; floor at 8 for the efficiency score.
  oracleMinimumToolCalls: 8,
  // The system prompt deliberately omits the standard workflow guidance
  // ("set_breakpoint then wait_for_pause then click"), so a model that
  // either misidentifies the bug under that handicap OR exceeds the 15
  // tool-call cap is producing the design-intent outcome. The 2026-05
  // macOS run had this scenario fail correctness while the other seven
  // passed — that's the observed-stable baseline. Reported as XFAIL by
  // the grader (rollupScenario) so the run exits 0 with the correct
  // signal in the scoreboard. A future XPASS (model unexpectedly
  // identifies the bug despite degraded guidance) prints `XPASS!` to
  // prompt the operator to consider dropping the tag.
  xfailCorrectness: true,
  // LEO-400: the mechanic axis is likewise expected-not-forced. The bug
  // is a literal `return 2` readable straight from source, so no prompt
  // can *guarantee* the breakpoint→pause flow — a capable model may
  // legitimately confirm the value by other means. Tagged so a static
  // shortcut reports XFAIL (tolerated) rather than a bare FAIL, and a
  // run that does drive the debugger reports XPASS! (the desired flow).
  xfailMechanic: true,
};
