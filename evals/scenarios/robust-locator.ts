// Scenario: robust-locator — locator authoring with suggest_locator. The agent
// must find a stable, unambiguous locator for the "Go" button (one that won't
// break under a CSS/DOM refactor), confirm via `locate` that it resolves to
// exactly one element, and report it. The trap: settling for a brittle CSS
// locator when an unambiguous semantic one (role+name, or text) exists. Uses
// the stock sample-app (#go button).
//
// Covers (issue #12): suggest_locator (ranked candidates + recommended index).

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { DRIVING_SYSTEM, out, last, mutatedViaEvaluate } from "./_driving-prompts.js";

interface Locator {
  by?: string;
  role?: string;
  name?: string;
  text?: string;
  test_id?: string;
  label?: string;
  placeholder?: string;
  css?: string;
  selector?: string;
}

/** Does an action's input represent (structurally) the same locator as a candidate? */
function locatorMatchesInput(loc: Locator, input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const i = input as Locator;
  switch (loc.by) {
    case "role":
      return i.role === loc.role && i.name === loc.name;
    case "text":
      return i.text === loc.text || i.name === loc.text;
    case "test_id":
      return i.test_id === loc.test_id;
    case "label":
      return i.label === loc.label;
    case "placeholder":
      return i.placeholder === loc.placeholder;
    case "name":
      return i.name === loc.name && (i.by === "name" || i.role === undefined);
    case "css":
      return (i.css ?? i.selector) === loc.css;
    default:
      return false;
  }
}

/** Lenient: does the final answer report this (unambiguous) candidate? */
function locatorAppearsInText(loc: Locator, text: string): boolean {
  const t = text.toLowerCase();
  switch (loc.by) {
    case "role":
      // Require the accessible NAME to actually appear — a bare "use a role
      // locator" must not count (Copilot, PR #17 round 2).
      return (
        !!loc.name &&
        t.includes(loc.name.toLowerCase()) &&
        (/\brole\b|getbyrole/.test(t) || (!!loc.role && t.includes(loc.role.toLowerCase())))
      );
    case "text":
      return !!loc.text && t.includes(loc.text.toLowerCase());
    case "test_id":
      return !!loc.test_id && t.includes(loc.test_id.toLowerCase());
    case "label":
      return !!loc.label && t.includes(loc.label.toLowerCase());
    case "placeholder":
      return !!loc.placeholder && t.includes(loc.placeholder.toLowerCase());
    case "css":
      return !!loc.css && t.includes(loc.css.toLowerCase());
    case "name":
      return !!loc.name && t.includes(loc.name.toLowerCase());
    default:
      return false;
  }
}

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  const sg = last(ok("suggest_locator"));
  const candidates = (out(sg).candidates ?? []) as Array<{
    locator: Locator;
    match_count: number;
    unambiguous: boolean;
    resolves_to_target: boolean;
  }>;
  const recommended = out(sg).recommended as number | null | undefined;

  // MECHANIC — called suggest_locator and then verified a returned candidate
  // with a LocatorSpec-driven tool (locate/wait_for).
  const calledSuggest = !!sg;
  // The verifying call must actually resolve the candidate to exactly ONE element
  // — the scenario's whole point is "confirm it resolves to exactly one element".
  // A structural input match alone (ignoring the result) would let count:0/2 pass
  // (codex, PR #17).
  const verified = c.some((x) => {
    if (!(x.tool === "locate" || x.tool === "wait_for") || x.isError) return false;
    const o = out(x);
    // locate exposes top-level `count`; wait_for nests it under `result`
    // (src/tools/dom.ts) — read the right shape per tool (codex, PR #17 round 2).
    const cnt = x.tool === "wait_for" ? Number((o.result as { count?: unknown } | undefined)?.count) : Number(o.count);
    return cnt === 1 && candidates.some((k) => locatorMatchesInput(k.locator, x.input));
  });
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 = calledSuggest && verified && noEvalMutation ? 1 : 0;

  // CORRECTNESS — the recommended candidate is unambiguous and the agent
  // reports a genuinely unambiguous candidate. Accept ANY unambiguous candidate
  // (role+name OR text both qualify for the Go button) — don't force by:role.
  const unambig = candidates.filter((k) => k.match_count === 1 && k.resolves_to_target);
  const recommendedUnambig =
    typeof recommended === "number" &&
    candidates[recommended]?.match_count === 1 &&
    candidates[recommended]?.resolves_to_target === true;
  const faReportsUnambig = unambig.some((k) => locatorAppearsInText(k.locator, finalAnswer));
  const correctness: 0 | 1 = calledSuggest && recommendedUnambig && faReportsUnambig && noEvalMutation ? 1 : 0;

  const why: string[] = [];
  if (!calledSuggest) why.push("mechanic: never called suggest_locator");
  if (!verified) why.push("mechanic: did not verify a candidate resolves to exactly one element via locate/wait_for");
  if (!noEvalMutation) why.push("mechanic/correctness: mutated page state via raw evaluate");
  if (!recommendedUnambig) why.push("correctness: suggest_locator's recommended candidate was not unambiguous");
  if (!faReportsUnambig) why.push("correctness: final answer did not report an unambiguous locator");

  const summary = `robust-locator correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — suggested, verified, and reported an unambiguous locator`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const robustLocator: Scenario = {
  name: "robust-locator",
  variantDir: "examples/sample-app/dist",
  prompt: `An automation script needs a stable, unambiguous locator for the page's "Go" button — one that won't break if the page's CSS classes or DOM structure are refactored. Use suggest_locator to get ranked candidates, pick the most robust one that matches exactly one element, confirm with locate that it resolves to exactly one element, and report the locator you chose.`,
  systemPromptOverride: DRIVING_SYSTEM,
  oracle,
  // launch + navigate + suggest_locator + locate (verify) (+ optional query_selector) ≈ 5.
  oracleMinimumToolCalls: 5,
};
