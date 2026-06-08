// Scenario: clearing-fill — replace semantics. A pre-filled field must be set
// to EXACTLY a new value. The trap: type_text is append-only (Input.insertText
// after focus, no clear), so an agent that reaches for it produces the
// concatenation "Old Draft NameGrace Hopper". `fill` (or type_text with
// clear_first) is the correct replace. Uses the `prefilled-form` variant
// (the stock #name-input starts empty, so it can't express "replace").
//
// Covers (issue #12): fill (replace semantics) — the highest-signal
// discrimination test for the fill-vs-type_text distinction.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { DRIVING_SYSTEM, out, last, inputText, mutatedViaEvaluate } from "./_driving-prompts.js";

const PROMPT = `The "Display name" field on the page is already filled in with an old value. Change it so the field contains exactly "Grace Hopper" — no more, no less (do not append to what is already there). Then read the field back and report its exact contents.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  // MECHANIC — used `fill` (the replace tool under test) and didn't cheat via JS.
  const usedFill = ok("fill").some((x) => out(x).status === "filled");
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 = usedFill && noEvalMutation ? 1 : 0;

  // CORRECTNESS — the field ends EXACTLY at the target. Prefer the
  // get_form_state read-back; if the agent verified some other way (no
  // display-name in the last get_form_state), fall back to "filled with the
  // target value and never appended via type_text" — fill has replace
  // semantics, so that guarantees the exact value by construction. An
  // append-only type_text solve yields "Old Draft NameGrace Hopper", which the
  // read-back path catches as a mismatch (and trips mechanic for not using fill).
  const fs = out(last(ok("get_form_state"))).fields as Record<string, { value?: unknown }> | undefined;
  const readBack = fs?.["display-name"]?.value;
  const filledTarget = c.some(
    (x) => x.tool === "fill" && !x.isError && (x.input as { value?: unknown })?.value === "Grace Hopper",
  );
  // Scope the append-check to the Display name field — an unrelated type_text
  // elsewhere must not invalidate a correct fill on this field (Copilot, PR #17).
  const appendedType = c.some(
    (x) =>
      x.tool === "type_text" &&
      !(x.input as { clear_first?: boolean })?.clear_first &&
      /display-name|display name/i.test(inputText(x.input)),
  );
  const exact = readBack === "Grace Hopper" || (readBack === undefined && filledTarget && !appendedType);
  // Lenient answer check — naming the new value is enough; mentioning the old
  // value for context ("replaced 'Old Draft Name' with ...") must NOT fail it.
  const faOk = /grace\s*hopper/i.test(finalAnswer);
  const correctness: 0 | 1 = exact && faOk && noEvalMutation ? 1 : 0;

  const why: string[] = [];
  if (!usedFill) why.push("mechanic: no successful fill");
  if (!noEvalMutation) why.push("mechanic/correctness: mutated the field via raw evaluate");
  if (!exact) why.push('correctness: field value is not exactly "Grace Hopper" (append-only type_text concatenates)');
  if (!faOk) why.push("correctness: final answer did not report the exact new value");

  const summary = `clearing-fill correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — field replaced exactly via fill`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const clearingFill: Scenario = {
  name: "clearing-fill",
  variantDir: "evals/sample-app-variants/prefilled-form/dist",
  prompt: PROMPT,
  systemPromptOverride: DRIVING_SYSTEM,
  oracle,
  // launch + navigate + fill + get_form_state = 4.
  oracleMinimumToolCalls: 4,
};
