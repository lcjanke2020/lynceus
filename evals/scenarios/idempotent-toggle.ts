// Scenario: idempotent-toggle — state-aware checkbox/radio driving. The
// `prefilled-form` variant starts with "Email updates" (#subscribe) and "Beta
// features" (#beta) both CHECKED and the plan radio on "Free". The task: keep
// Email updates ON, turn Beta OFF, select the "Pro" plan. The trap: blindly
// clicking a checkbox that's already on toggles it OFF — `check`/`uncheck` are
// idempotent and state-aware, so they're the right tools.
//
// The oracle keys off the tool's own status field, which cleanly separates the
// three actions without guessing at locators:
//   - check on the already-on box  → status "already-checked" (idempotent)
//   - check on the off radio        → status "checked"        (state change)
//   - uncheck on the on box         → status "unchecked"      (state change)
//
// Covers (issue #12): check (idempotent already-checked + state-changing on a
// radio), uncheck.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { DRIVING_SYSTEM, out, last, mutatedViaEvaluate } from "./_driving-prompts.js";

const PROMPT = `Set the preferences form to this exact state, using the state-aware toggle tools (not raw clicks):
- "Email updates" must end up ON. It may already be on — that's fine, just guarantee it stays on.
- "Beta features" must end up OFF.
- The plan must be set to "Pro".
Then read the form back and report the final state of all three.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  // MECHANIC — distinguished purely by the idempotent status envelope.
  const idempotentCheck = ok("check").some((x) => out(x).status === "already-checked" && out(x).checked === true);
  const radioChecked = ok("check").some((x) => out(x).status === "checked" && out(x).checked === true);
  const betaUnchecked = ok("uncheck").some((x) => out(x).status === "unchecked" && out(x).checked === false);
  // The whole point: no blind clicking of controls (a click on the already-on
  // box would toggle it off). The task needs no click at all.
  const noClick = !c.some((x) => x.tool === "click");
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 =
    idempotentCheck && radioChecked && betaUnchecked && noClick && noEvalMutation ? 1 : 0;

  // CORRECTNESS — read-back confirms the three end states + the answer reports them.
  // Require get_form_state (all three controls are named, and the prompt asks to
  // read the form back). The tool-result statuses carry no locator, so a status
  // fallback can't prove the RIGHT controls were toggled — e.g. unchecking the
  // already-on Email box instead of Beta would pass (Copilot, PR #17 round 5).
  const fs = out(last(ok("get_form_state"))).fields as Record<string, { value?: unknown }> | undefined;
  const stateOk =
    !!fs && fs.subscribe?.value === true && fs.beta?.value === false && fs.plan?.value === "pro";
  const fa = finalAnswer.toLowerCase();
  // The prompt asks to "report the final state of all three", so require the
  // answer to name the fields AND an ON-ish and an OFF-ish state (Copilot, r5).
  const onish = /\b(on|checked|enabled|active|true|yes|selected)\b/.test(fa);
  const offish = /\b(off|unchecked|disabled|inactive|false|cleared|unselected)\b/.test(fa);
  const faOk =
    /(email|subscrib|updates)/.test(fa) && /beta/.test(fa) && /pro/.test(fa) && onish && offish;
  const correctness: 0 | 1 = stateOk && faOk && noEvalMutation ? 1 : 0;

  const why: string[] = [];
  if (!idempotentCheck) why.push('mechanic: no idempotent check (status "already-checked") on the on box');
  if (!radioChecked) why.push("mechanic: Pro plan not selected via check");
  if (!betaUnchecked) why.push("mechanic: Beta not turned off via uncheck");
  if (!noClick) why.push("mechanic: used a blind click (toggles, not state-aware)");
  if (!noEvalMutation) why.push("mechanic/correctness: mutated state via raw evaluate");
  if (!stateOk) why.push("correctness: get_form_state read-back missing or did not match subscribe=on, beta=off, plan=pro");
  if (!faOk) why.push("correctness: final answer did not report all three states (names + on/off)");

  const summary = `idempotent-toggle correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — idempotent check + uncheck + radio check, no blind clicks`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const idempotentToggle: Scenario = {
  name: "idempotent-toggle",
  variantDir: "evals/sample-app-variants/prefilled-form/dist",
  prompt: PROMPT,
  systemPromptOverride: DRIVING_SYSTEM,
  oracle,
  // launch + navigate + check + uncheck + check + get_form_state = 6.
  oracleMinimumToolCalls: 6,
};
