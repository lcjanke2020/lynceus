// Scenario: form-drive — multi-control form completion exercising tool
// DISCRIMINATION. The agent must pick the right driver tool per control:
// fill the text field, select_option the single + multi <select>, check the
// checkbox — NOT type_text into a select, NOT click the checkbox, NOT mutate
// via raw evaluate. Uses the stock sample-app (all four controls exist).
//
// Covers (issue #12): fill, select_option (single — by label), select_option
// (multi — by index, multiple:true), check.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { DRIVING_SYSTEM, out, last, inputText, mutatedViaEvaluate } from "./_driving-prompts.js";

const PROMPT = `Complete the signup form on the page, choosing the control type that fits each field:
- Set the name field to exactly "Ada Lovelace".
- In the single fruit picker, choose "Banana" (match it by its visible label).
- Turn the "Subscribe" newsletter checkbox on.
- In the favourite-fruits multi-select, select exactly "Apple" and "Cherry" (they are the 1st and 3rd options).
Then read the form back and report the final value of every field.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  // MECHANIC — the right dedicated tool per control, each succeeding.
  const filledName = ok("fill").some((x) => out(x).status === "filled");
  const singleFruit = ok("select_option").some((x) => {
    const o = out(x);
    return o.multiple === false && Array.isArray(o.selected) && o.selected.some((s: { value?: string }) => s.value === "banana");
  });
  const multiFruit = ok("select_option").some((x) => {
    const o = out(x);
    if (o.multiple !== true || !Array.isArray(o.selected)) return false;
    const vals = o.selected.map((s: { value?: string }) => s.value);
    return ["apple", "cherry"].every((v) => vals.includes(v)) && o.selected.length === 2;
  });
  const checkedSub = ok("check").some((x) => out(x).checked === true);
  // Discrimination guards: never typed into the select, never mutated via JS.
  const noTypeIntoSelect = !c.some((x) => x.tool === "type_text" && /fruit/i.test(inputText(x.input)));
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 =
    filledName && singleFruit && multiFruit && checkedSub && noTypeIntoSelect && noEvalMutation ? 1 : 0;

  // CORRECTNESS — read-back confirms the end state + the answer reports it.
  // The name field has no `name` attribute on the stock app, so get_form_state
  // can't see it; gate the name on the `fill` result + the answer text instead.
  const fs = out(last(ok("get_form_state"))).fields as Record<string, { value?: unknown }> | undefined;
  const multiVal = fs?.["fruits-multi"]?.value;
  const multiOk =
    Array.isArray(multiVal) &&
    ["apple", "cherry"].every((v) => (multiVal as string[]).includes(v)) &&
    (multiVal as string[]).length === 2;
  const endStateOk = fs
    ? fs.fruit?.value === "banana" && fs.subscribe?.value === true && multiOk
    : singleFruit && multiFruit && checkedSub; // fallback to tool-result statuses
  const fa = finalAnswer.toLowerCase();
  const faOk =
    /ada\s*lovelace/i.test(finalAnswer) &&
    /banana/.test(fa) &&
    /(subscrib|true|on\b|checked|yes|enabled)/.test(fa) &&
    /apple/.test(fa) &&
    /cherry/.test(fa);
  // Anti-cheat: an evaluate-mutation solve does not count, even if the end state is right.
  const correctness: 0 | 1 = endStateOk && faOk && noEvalMutation ? 1 : 0;

  const why: string[] = [];
  if (!filledName) why.push("mechanic: no successful fill on the name field");
  if (!singleFruit) why.push("mechanic: single select_option did not set fruit=banana");
  if (!multiFruit) why.push("mechanic: multi select_option did not set exactly apple+cherry");
  if (!checkedSub) why.push("mechanic: subscribe not checked via check");
  if (!noTypeIntoSelect) why.push("mechanic: used type_text on a <select>");
  if (!noEvalMutation) why.push("mechanic/correctness: mutated state via raw evaluate");
  if (!endStateOk) why.push("correctness: get_form_state read-back did not match the target state");
  if (!faOk) why.push("correctness: final answer did not report all field values");

  const summary = `form-drive correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — each control driven with the right tool + read-back confirmed`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const formDrive: Scenario = {
  name: "form-drive",
  variantDir: "examples/sample-app/dist",
  prompt: PROMPT,
  systemPromptOverride: DRIVING_SYSTEM,
  oracle,
  // launch + navigate + fill + select_option + check + select_option + get_form_state = 7.
  oracleMinimumToolCalls: 7,
};
