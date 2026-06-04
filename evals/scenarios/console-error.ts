// Scenario: console-error — variant throws a TypeError in the click
// handler.
//
// The agent should: pull the console buffer (filtered to level:error),
// see a source-mapped exception, and report the original TS file:line
// where the throw originated.
//
// Validates the source-mapped exception path specifically (the
// pushConsoleFromException helper in src/session/browser.ts).

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify the console buffer + source-mapped exception path. Clicking "Go" throws a JavaScript error and the counter doesn't update. Click the button to trigger the error, then call get_console_logs (filter to error level if you like) and find the source-mapped throw site. Report the error kind and the source file:line where it originated.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent triggered the error and pulled the buffer.
  const pulledConsole = calls.some((c) => c.tool === "get_console_logs" && !c.isError);
  const clicked = calls.some((c) => c.tool === "click");
  const mechanic: 0 | 1 = pulledConsole && clicked ? 1 : 0;

  // CORRECTNESS checks — answer names the error kind + source file.
  const fa = finalAnswer.toLowerCase();
  // Require a more specific signal than a bare "null"/"undefined" word —
  // PR #15 review: "the counter shows null" used to pass without the
  // agent ever surfacing the actual TypeError. Accept the exception
  // class name OR a phrase that names the access pattern.
  const mentionsErrorKind =
    /typeerror|cannot\s+(read|set\s+properties)\s+of\s+(null|undefined)/i.test(fa);
  const mentionsSourceFile = /main\.ts|handlers\.ts/i.test(finalAnswer);
  const correctness: 0 | 1 = mentionsErrorKind && mentionsSourceFile ? 1 : 0;

  const why: string[] = [];
  if (!pulledConsole) why.push("mechanic: agent never called get_console_logs");
  if (!clicked) why.push("mechanic: agent never clicked to trigger the error");
  if (!mentionsErrorKind)
    why.push("correctness: answer doesn't name the error kind (TypeError / null / cannot read)");
  if (!mentionsSourceFile) why.push("correctness: answer doesn't point at a .ts file");

  const summary = `console-error correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: agent triggered the error, pulled the console, named the source`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const consoleError: Scenario = {
  name: "console-error",
  variantDir: "evals/sample-app-variants/console-error/dist",
  prompt: PROMPT,
  oracle,
  oracleMinimumToolCalls: 5,
};
