// Scenario: node-conditional-bp — Node-target variant of the conditional
// breakpoint workflow. The fixture loops `for (let i = 0; i < 5; i++)`
// calling `processIteration(i)` on conditional-bp.ts:16, and the
// `processIteration` impl on line 7-12 returns `i * 10` only when
// `i === 3` (line 8-10) — every other iteration returns `i` correctly.
//
// The elegant agent recognizes the loop-with-one-bad-iteration pattern
// and sets a CONDITIONAL breakpoint with `condition: "i === 3"` (or
// similar) on the loop's call-site line, so V8 pauses ONLY on the
// matching iteration instead of 5×{pause, inspect, resume}. The Node
// surface has no `click` analogue, so unlike the browser conditional-bp
// scenario there's no brute-force fallback — the mechanic gate REQUIRES
// (a) a non-empty `condition` on a successful set_breakpoint OUTSIDE
// the `if (i === 3)` branch (lines 9-10) so the condition is the only
// thing keeping it from firing every iteration, (b) the debugger
// honored it (bp id appears in `hit_breakpoint_ids`), and (c) the
// FIRST bp hit's inspection window proves i===3 — a non-narrowing
// `"true"` condition would pause at i=0 first and fail this gate.
//
// Workflow: launch_node → wait_for_pause (entry) → set_breakpoint
// (conditional-bp.ts:16, condition: "i === 3") → resume → wait_for_pause
// (bp hit on i===3) → get_scope / evaluate → resume → close ≈ 7 calls.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: a Node script loops over a small range calling \`processIteration(i)\` once per iteration and produces wrong output for exactly one specific value of \`i\`. Use the debugger's condition support on \`set_breakpoint\` to halt only on the matching iteration — avoid pausing on every iteration. Diagnose which \`i\` triggers the bug, identify what \`processIteration\` does wrong on that iteration, and report the offending source location as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // Lines INSIDE the `if (i === 3) { return i * 10 }` branch — control
  // flow already gates these to i===3, so any condition there is
  // decorative (the bp fires only on the target iteration regardless of
  // condition). Codex P1 (re-review): a bp on line 9 + `condition: "i === 3"`
  // would satisfy the prior gate even though the condition wasn't doing
  // the narrowing. Reject these lines so the condition has to be
  // load-bearing — the canonical pattern is a bp on the loop body (e.g.
  // line 16's `processIteration(i)` call site) where without a condition
  // the bp fires on every iteration.
  const BP_LINES_INSIDE_BUGGY_BRANCH: ReadonlySet<number> = new Set([9, 10]);

  // 1. usedConditionalBp — MANDATORY. At least one successful
  //    set_breakpoint on conditional-bp.ts at a line OUTSIDE the
  //    `if (i === 3)` branch (so the condition is load-bearing), with a
  //    non-empty trimmed `condition` field. NO brute-force fallback
  //    (unlike browser conditional-bp, which accepts >=3 clicks instead
  //    — Node has no click). We capture the resulting bp id so the next
  //    gate can confirm V8 honored the condition rather than the agent
  //    setting one and then ignoring it.
  //
  //    `.trim().length > 0` rules out whitespace-only conditions like
  //    `"   "` that satisfy V8 as truthy strings but don't narrow.
  const conditionalBpIds = new Set<string>();
  for (const c of calls) {
    if (
      c.tool === "set_breakpoint" &&
      !c.isError &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("conditional-bp.ts") &&
      typeof (c.input as { line?: unknown }).line === "number" &&
      !BP_LINES_INSIDE_BUGGY_BRANCH.has((c.input as { line: number }).line) &&
      typeof (c.input as { condition?: unknown }).condition === "string" &&
      ((c.input as { condition: string }).condition.trim().length) > 0 &&
      typeof c.output === "object" &&
      c.output !== null
    ) {
      const id = (c.output as { id?: unknown }).id;
      if (typeof id === "string") conditionalBpIds.add(id);
    }
  }
  const usedConditionalBp = conditionalBpIds.size > 0;

  // 2. bpHit — index of the first wait_for_pause whose hit_breakpoint_ids
  //    contains one of our conditional bp ids. Membership, NOT `reason`
  //    equality (V8 emits values outside the protocol union — see
  //    test/e2e/node-breakpoint-flow.e2e.test.ts:12-21). We capture the
  //    index so the next gate can constrain inspection to AFTER the hit
  //    (mirrors evals/scenarios/worker-bug.ts:65-77 — a naive
  //    `calls.some` admits pre-pause inspections that don't prove
  //    anything about the conditional pause).
  const bpHitIdx = calls.findIndex(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      Array.isArray((c.output as { hit_breakpoint_ids?: unknown }).hit_breakpoint_ids) &&
      ((c.output as { hit_breakpoint_ids: unknown[] }).hit_breakpoint_ids as unknown[]).some(
        (id) => typeof id === "string" && conditionalBpIds.has(id),
      ),
  );
  const bpHit = bpHitIdx >= 0;

  // 3. inspectedAfterBpHit — at least one successful inspection AFTER
  //    the bp-hit pause index. A pre-pause get_scope (e.g. against the
  //    entry pause) doesn't prove the agent inspected the conditional
  //    pause's frame.
  const inspectedAfterBpHit =
    bpHit &&
    calls
      .slice(bpHitIdx + 1)
      .some(
        (c) =>
          !c.isError &&
          ["get_call_stack", "get_scope", "evaluate"].includes(c.tool),
      );

  // 4. firstHitIsTargetIteration (Codex P1 re-review) — the FIRST hit of
  //    the conditional bp must prove i===3. Restrict the inspection
  //    window to between the bp-hit pause (bpHitIdx) and the NEXT resume.
  //    A non-narrowing condition like `"true"` or `"i >= 0"` fires at
  //    i=0 first; if the agent inspects there it sees i=0 (not i=3) and
  //    this gate fails. If the agent resumes past i=0 without inspecting
  //    and only inspects on a later iteration where i=3 happens to land,
  //    the first-hit window is empty so the gate also fails — by then
  //    they've already paused on iterations the condition was supposed
  //    to skip, so the condition didn't actually narrow.
  //
  //    Evaluate is restricted to the literal expression "i" only:
  //    `evaluate("i * 10") -> 30` proves i=3 indirectly but the
  //    inference chain isn't safe to encode programmatically. The
  //    the original smoke trace passes via the get_scope path
  //    (get_scope returned `items: [{name: "i", preview: "3"}]` between
  //    the bp-hit pause and the terminal resume — verified by offline
  //    replay of a smoke-run trace).
  let firstHitIsTargetIteration = false;
  if (bpHit) {
    const remaining = calls.slice(bpHitIdx + 1);
    const nextResumeOffset = remaining.findIndex((c) => c.tool === "resume");
    const firstHitWindow =
      nextResumeOffset >= 0 ? remaining.slice(0, nextResumeOffset) : remaining;
    firstHitIsTargetIteration = firstHitWindow.some((c) => {
      if (c.isError) return false;
      if (c.tool === "get_scope") {
        const items = (c.output as { items?: unknown }).items;
        if (!Array.isArray(items)) return false;
        return (items as Array<{ name?: unknown; preview?: unknown; value?: unknown }>).some(
          (item) => {
            if (item?.name !== "i") return false;
            const preview = item?.preview;
            const value = (item as { value?: unknown }).value;
            return (
              preview === "3" ||
              String(preview ?? "") === "3" ||
              value === 3 ||
              Number(value) === 3
            );
          },
        );
      }
      if (c.tool === "evaluate") {
        const input = c.input as { expression?: unknown };
        const output = c.output as { value?: unknown };
        const expr = String(input?.expression ?? "").trim();
        if (expr !== "i") return false;
        const value = output?.value;
        return value === 3 || Number(value) === 3;
      }
      return false;
    });
  }

  const mechanic: 0 | 1 =
    usedConditionalBp && bpHit && inspectedAfterBpHit && firstHitIsTargetIteration ? 1 : 0;

  // CORRECTNESS — the final answer must:
  //   (a) mention conditional-bp.ts (the file)
  //   (b) identify i===3 (or "third iteration", "i = 3", "i is 3") as the
  //       triggering input
  //   (c) name the bug — `processIteration` OR `i * 10` (in any phrasing)
  //       OR explicitly cite line 9 (the offending `return i * 10` line)
  //
  // Trigger regex split into explicit alternatives with word boundaries
  // (Copilot inline upstream review): the previous tail `i\s*==\s*3`
  // lacked a trailing `\b` and would false-positive on `i == 30` via
  // prefix match.
  const fa = finalAnswer.toLowerCase();
  const mentionsFile = /conditional-bp\.ts/i.test(finalAnswer);
  const mentionsTrigger =
    /\bi\s*===\s*3\b/i.test(fa) ||
    /\bi\s*==\s*3\b/i.test(fa) ||
    /\bi\s*=\s*3\b/i.test(fa) ||
    /\bi\s+is\s+3\b/i.test(fa) ||
    /\bthird\s+iteration\b/i.test(fa) ||
    /\b3rd\s+iteration\b/i.test(fa);
  const mentionsBugFact =
    /processiteration|\bi\s*\*\s*10\b|times\s*10|multiplied\s+by\s+10|tenfold|return\s+i\s*\*\s*10/i.test(fa) ||
    /\b9\b/.test(finalAnswer); // line 9 in conditional-bp.ts (the buggy return)
  const correctness: 0 | 1 = mentionsFile && mentionsTrigger && mentionsBugFact ? 1 : 0;

  const why: string[] = [];
  if (!usedConditionalBp)
    why.push(
      "mechanic: no set_breakpoint on conditional-bp.ts at a line outside the `if (i === 3)` branch (lines 9-10) with a non-empty trimmed condition",
    );
  if (!bpHit)
    why.push("mechanic: wait_for_pause never returned hit_breakpoint_ids containing the conditional bp");
  if (!inspectedAfterBpHit)
    why.push("mechanic: no successful inspection (get_call_stack / get_scope / evaluate) AFTER the bp-hit pause");
  if (!firstHitIsTargetIteration)
    why.push(
      "mechanic: the FIRST bp-hit pause did not prove i===3 — window between bp-hit pause and next resume must show i===3 via get_scope or evaluate(\"i\")",
    );
  if (!mentionsFile) why.push("correctness: answer doesn't mention conditional-bp.ts");
  if (!mentionsTrigger) why.push("correctness: answer doesn't identify i===3 as the trigger");
  if (!mentionsBugFact)
    why.push("correctness: answer doesn't name the bug (processIteration / i*10 / line 9)");

  const summary = `node-conditional-bp correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — conditional bp wired (id matched in hit_breakpoint_ids), inspection done, i===3 + bug fact named`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const nodeConditionalBp: Scenario = {
  name: "node-conditional-bp",
  target: { kind: "node", script: "examples/sample-node-app/dist/conditional-bp.js" },
  prompt: PROMPT,
  oracle,
  // launch_node, wait_for_pause (entry), set_breakpoint (with condition),
  // resume, wait_for_pause (bp hit), inspect, resume/close = ~7. Floor
  // mirrors the browser conditional-bp scenario.
  oracleMinimumToolCalls: 7,
};
