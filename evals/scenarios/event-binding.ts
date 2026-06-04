// Scenario: event-binding — variant binds the wrong event name.
//
// The variant's main.ts uses `addEventListener("clik", ...)` (typo) so
// clicking the button does nothing — no JS runs at all. The agent that
// blindly tries the compute-step approach (set_breakpoint + wait_for_
// pause) will time out on wait_for_pause; it has to recognize that
// silence is the symptom and switch strategies (inspect the DOM,
// check listeners, read main.ts source).
//
// Plan rev 6 oracle: `trace.filter(c => c.tool === "wait_for_pause").
// length <= 2` (proves the agent didn't keep retrying); trace contains
// at least one query_selector or get_element_html after the second
// wait_for_pause; final answer mentions either "no listener" or the
// typo'd event name.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify the DOM inspection tools as a fallback when breakpoints don't fire. The "Go" button is supposed to update a counter — but clicking does nothing at all (no error, no event). Try the standard breakpoint workflow first, but when wait_for_pause doesn't trigger, pivot: use query_selector or get_element_html on the button to inspect its event listeners. Report what's wrong as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent didn't loop on wait_for_pause AND pivoted to DOM.
  const waitForPauseCalls = calls.filter((c) => c.tool === "wait_for_pause").length;
  const didNotRetryEndlessly = waitForPauseCalls <= 2;
  const inspectedDom = calls.some((c) =>
    ["query_selector", "get_element_html", "evaluate"].includes(c.tool),
  );
  const mechanic: 0 | 1 = didNotRetryEndlessly && inspectedDom ? 1 : 0;

  // CORRECTNESS check — answer names the typo or missing listener.
  const fa = finalAnswer.toLowerCase();
  const mentionsTypoOrMissingListener =
    /clik/i.test(finalAnswer) ||
    /no\s+(event\s+)?listener|missing\s+listener|wrong\s+event/i.test(fa) ||
    /typo/i.test(fa);
  const mentionsMainTs = /main\.ts/i.test(finalAnswer);
  const correctness: 0 | 1 = mentionsTypoOrMissingListener && mentionsMainTs ? 1 : 0;

  const why: string[] = [];
  if (!didNotRetryEndlessly)
    why.push(`mechanic: ${waitForPauseCalls} wait_for_pause calls — agent didn't pivot from breakpoint approach`);
  if (!inspectedDom)
    why.push("mechanic: no DOM inspection (query_selector / get_element_html / evaluate)");
  if (!mentionsTypoOrMissingListener)
    why.push("correctness: answer does not mention the typo, wrong event name, or missing listener");
  if (!mentionsMainTs) why.push("correctness: answer does not mention main.ts");

  const summary = `event-binding correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: agent recognized no-pause as a signal and inspected the DOM`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const eventBinding: Scenario = {
  name: "event-binding",
  variantDir: "evals/sample-app-variants/event-binding/dist",
  prompt: PROMPT,
  oracle,
  oracleMinimumToolCalls: 5,
};
