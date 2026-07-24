// Scenario: react-context-provider — the bridge-mandatory partner to the
// stale-closure control. SettingsWidget receives an object created lazily by
// the nearest provider. Its high-entropy providerId is never rendered or put
// on a page global, so a correct answer must be grounded in a successful
// inspect_react_component payload rather than checked-in source.

import type { OracleResult, Scenario, TraceEntry } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import {
  REACT_INSPECTION_SYSTEM,
  accessedReactInternalsViaEvaluate,
  hasSuccessfulReactAttach,
  inspectedReactComponents,
  locatedReactComponent,
  readRuntimeContextObservation,
  type ReactPair,
  type RuntimeContextObservation,
} from "./_react-helpers.js";

const PROMPT = `The settings widget renders with the wrong theme even though the top-level ThemeContext provider is configured for light mode. Exercise the React inspection workflow: attach the backend, locate SettingsWidget in the materialized tree, inspect that consumer's live hooks/context, and identify the nearest provider value it actually receives. Report the provider component, the exact runtime theme, and the exact runtime providerId (the rdt-inner-* value).`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace) as ReactPair[];
  const attached = hasSuccessfulReactAttach(calls);
  const located = locatedReactComponent(calls, "SettingsWidget");
  const inspections = inspectedReactComponents(calls, "SettingsWidget");
  const observations = inspections
    .map((inspection) => readRuntimeContextObservation(inspection))
    .filter(
      (observation): observation is RuntimeContextObservation =>
        observation !== null,
    );
  const noRawReactBypass = !accessedReactInternalsViaEvaluate(calls);
  const mechanic: 0 | 1 =
    attached && located && observations.length > 0 && noRawReactBypass ? 1 : 0;

  const namesProvider =
    /RuntimeThemeBoundary/i.test(finalAnswer) &&
    /provider|boundary|nearest|inner|nested/i.test(finalAnswer);
  const answerLower = finalAnswer.toLowerCase();
  const namesObservedPair = observations.some(
    ({ theme, providerId }) =>
      answerLower.includes(theme.toLowerCase()) &&
      answerLower.includes(providerId.toLowerCase()),
  );
  const correctness: 0 | 1 =
    namesProvider && namesObservedPair && noRawReactBypass
      ? 1
      : 0;

  const why: string[] = [];
  if (!attached) why.push("mechanic: attach_react_devtools did not succeed");
  if (!located)
    why.push("mechanic: tree/find result did not contain SettingsWidget");
  if (inspections.length === 0)
    why.push("mechanic: SettingsWidget was not successfully inspected");
  else if (observations.length === 0)
    why.push(
      "mechanic: SettingsWidget inspection lacked a runtime rdt-inner provider value",
    );
  if (!noRawReactBypass)
    why.push("mechanic/correctness: raw evaluate accessed React internals");
  if (!namesProvider)
    why.push("correctness: final answer does not identify RuntimeThemeBoundary's provider");
  if (!namesObservedPair)
    why.push(
      "correctness: final answer does not report an inspected runtime theme/providerId pair",
    );

  const summary = `react-context-provider correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — the exact nearest-provider value came from SettingsWidget inspection`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const reactContextProvider: Scenario = {
  name: "react-context-provider",
  target: {
    kind: "browser",
    webAppDir: "examples/sample-fullstack-app",
    webUrl: "http://127.0.0.1:5173/?rdt_scenario=context-provider",
  },
  prompt: PROMPT,
  systemPromptOverride: REACT_INSPECTION_SYSTEM,
  oracle,
  oracleMinimumToolCalls: 7,
};
