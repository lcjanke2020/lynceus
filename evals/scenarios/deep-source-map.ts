// Scenario: deep-source-map — variant has the bug nested in
// src/lib/utils/math.ts (not at the top of src/).
//
// Tests the source-map matcher's suffix-match logic: when the agent
// passes `lib/utils/math.ts` or just `math.ts`, the source-map store
// should resolve correctly via pathMatches (src/sourcemap/normalize.ts).
// Also tests that the agent's exploration scales to deeper file trees —
// a real-world project has many such nests.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify source-map resolution on a deeply-nested TypeScript file. Clicking "Go" gives the wrong counter value. The math helper somewhere in the source tree has a bug. Set a breakpoint by TS filename (the resolver does suffix-match — try just \`math.ts\` or the full \`lib/utils/math.ts\` path), drive the page to trigger it, pause, and report file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent set a bp at the deeply-nested file and paused.
  const breakpointInMath = calls.some((c) => {
    if (c.tool !== "set_breakpoint") return false;
    const file = String(
      (c.input as { file?: unknown } | undefined)?.file ?? "",
    );
    return file.endsWith("math.ts") || /lib\/utils\/math/.test(file);
  });
  const sawPause = calls.some(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null,
  );
  const mechanic: 0 | 1 = breakpointInMath && sawPause ? 1 : 0;

  // CORRECTNESS check — answer must name the actual bug expression, not
  // just the file path. The prompt mentions "math.ts" and "lib/utils/math.ts"
  // already, so matching those alone would let an agent score correctness
  // by parroting the prompt. Require the literal buggy expression
  // (`a + b + 1`) OR a clear description of the off-by-one nature
  // (PR #38 GPT-5 review).
  const fa = finalAnswer.toLowerCase();
  const mentionsMath = /math\.ts/i.test(finalAnswer);
  const mentionsBugFact =
    /a\s*\+\s*b\s*\+\s*1/i.test(fa) ||
    /off[\s-]by[\s-]one/i.test(fa) ||
    /\bplus\s+1\s+(too\s+many|extra)/i.test(fa) ||
    /(returns?|adds?)\s+(an?\s+)?(extra\s+)?1\b/i.test(fa);
  const correctness: 0 | 1 = mentionsMath && mentionsBugFact ? 1 : 0;

  const why: string[] = [];
  if (!breakpointInMath) why.push("mechanic: no breakpoint set in math.ts (or lib/utils path)");
  if (!sawPause) why.push("mechanic: no pause observed");
  if (!mentionsMath) why.push("correctness: answer doesn't mention math.ts");
  if (!mentionsBugFact)
    why.push("correctness: answer doesn't name the bug (a + b + 1 / off-by-one / extra 1)");

  const summary = `deep-source-map correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: source-map suffix match resolved correctly`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const deepSourceMap: Scenario = {
  name: "deep-source-map",
  variantDir: "evals/sample-app-variants/deep-source-map/dist",
  prompt: PROMPT,
  oracle,
  // launch + navigate + list_scripts (to find the math file) + set_bp +
  // click + wait + inspect + resume ≈ 8.
  oracleMinimumToolCalls: 8,
};
