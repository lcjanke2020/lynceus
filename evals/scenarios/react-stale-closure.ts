// Scenario: react-stale-closure — source-solvable control for the React
// inspection mechanic. The dedicated bridge can prove the live State hook is
// frozen at 1, but React DevTools cannot expose the interval callback's lexical
// closure or effect dependencies. The source diagnosis therefore remains
// intentionally shortcut-able; xfailMechanic distinguishes that behavioral
// shortcut from a broken bridge when paired with react-context-provider.

import type { OracleResult, Scenario, TraceEntry } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import {
  REACT_INSPECTION_SYSTEM,
  accessedReactInternalsViaEvaluate,
  hasSuccessfulReactAttach,
  inspectedReactComponent,
  inspectionHasStateValue,
  locatedReactComponent,
  type ReactPair,
} from "./_react-helpers.js";

const PROMPT = `The page's auto-incrementing counter reaches 1 and then stays there instead of continuing upward. Exercise the React inspection workflow: attach the React backend, locate StaleCounter, and inspect its live hooks to confirm the current State value. Then use the TypeScript source to explain why the interval never advances it. Report the observed hook value and the bug as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace) as ReactPair[];
  const attached = hasSuccessfulReactAttach(calls);
  const located = locatedReactComponent(calls, "StaleCounter");
  const inspection = inspectedReactComponent(calls, "StaleCounter");
  const readFrozenState = inspectionHasStateValue(inspection, 1);
  const noRawReactBypass = !accessedReactInternalsViaEvaluate(calls);
  const mechanic: 0 | 1 =
    attached && located && readFrozenState && noRawReactBypass ? 1 : 0;

  const mentionsFile = /StaleCounter\.tsx/i.test(finalAnswer);
  const mentionsEffect = /use\s*effect|interval/i.test(finalAnswer);
  const namesStaleCapture =
    /stale\s+(?:closure|state)/i.test(finalAnswer) ||
    /(?:captur(?:e|es|ed|ing)|clos(?:e|es|ed|ing)\s+over)[\s\S]{0,80}(?:initial|old|stale|count|zero|0)/i.test(
      finalAnswer,
    );
  const namesDependencyCause =
    /(?:empty|missing|omitted|incorrect)\s+(?:effect\s+)?(?:dependency|dependencies|deps)(?:\s+array)?/i.test(
      finalAnswer,
    ) ||
    /(?:dependency|dependencies|deps)(?:\s+array)?[\s\S]{0,50}(?:empty|missing|omits?|count)/i.test(
      finalAnswer,
    ) ||
    /functional\s+(?:state\s+)?update|functional\s+updater/i.test(finalAnswer);
  const correctness: 0 | 1 =
    mentionsFile && mentionsEffect && namesStaleCapture && namesDependencyCause
      ? 1
      : 0;

  const why: string[] = [];
  if (!attached) why.push("mechanic: attach_react_devtools did not succeed");
  if (!located)
    why.push("mechanic: tree/find result did not contain StaleCounter");
  if (!inspection)
    why.push("mechanic: StaleCounter was not successfully inspected");
  else if (!readFrozenState)
    why.push("mechanic: StaleCounter inspection did not return State=1");
  if (!noRawReactBypass)
    why.push("mechanic: raw evaluate accessed React internals");
  if (!mentionsFile)
    why.push("correctness: final answer does not mention StaleCounter.tsx");
  if (!mentionsEffect)
    why.push("correctness: final answer does not identify the effect/interval");
  if (!namesStaleCapture)
    why.push("correctness: final answer does not identify a stale captured count");
  if (!namesDependencyCause)
    why.push("correctness: final answer does not identify the dependency/updater cause");

  const summary = `react-stale-closure correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — React inspection returned State=1 before the source diagnosis`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const reactStaleClosure: Scenario = {
  name: "react-stale-closure",
  target: {
    kind: "browser",
    webAppDir: "examples/sample-fullstack-app",
    webUrl: "http://127.0.0.1:5173/?rdt_scenario=stale-closure",
  },
  prompt: PROMPT,
  systemPromptOverride: REACT_INSPECTION_SYSTEM,
  oracle,
  // launch/navigate + attach + tree/find + inspect + source read +
  // detach/close. The floor is diagnostic; payload evidence gates mechanic.
  oracleMinimumToolCalls: 7,
  // Deliberately source-solvable: a shortcut is tolerated as XFAIL while a
  // genuine bridge confirmation is the desired XPASS signal.
  xfailMechanic: true,
};
