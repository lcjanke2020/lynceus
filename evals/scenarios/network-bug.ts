// Scenario: network-bug — variant fetches /api/wrong-endpoint (404)
// on click.
//
// The bug isn't visible in source — the URL is just wrong. The agent
// has to drive the page (click), inspect the network buffer, and name
// the 404 or the wrong URL. Tests get_network_requests specifically.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify the network-request buffer. Clicking "Go" fires a fetch that fails. The URL is wrong; the failure is not visible in source. Click the button to trigger the request, then call get_network_requests to inspect what actually went out and came back. Report the failing URL or status code.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent triggered the request and inspected the buffer.
  const clicked = calls.some((c) => c.tool === "click");
  const inspectedNetwork = calls.some((c) => c.tool === "get_network_requests" && !c.isError);
  const mechanic: 0 | 1 = clicked && inspectedNetwork ? 1 : 0;

  // CORRECTNESS check — answer surfaces a fact only obtainable from the
  // actual network response. The prompt mentions "wrong URL" already, so
  // matching that would let an agent score correctness by parroting the
  // prompt. Lock to the specific endpoint path or status code — both are
  // runtime-only facts the agent must have observed (PR #38 GPT-5 review).
  const fa = finalAnswer.toLowerCase();
  const mentions404 = /\b404\b|not\s+found/i.test(fa);
  const mentionsWrongEndpoint = /wrong-endpoint/i.test(fa);
  const correctness: 0 | 1 = mentions404 || mentionsWrongEndpoint ? 1 : 0;

  const why: string[] = [];
  if (!clicked) why.push("mechanic: agent never clicked to fire the request");
  if (!inspectedNetwork) why.push("mechanic: agent never called get_network_requests");
  if (!mentions404 && !mentionsWrongEndpoint)
    why.push("correctness: answer doesn't surface the 404 or the /api/wrong-endpoint path");

  const summary = `network-bug correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: agent clicked, inspected network, named the failure`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const networkBug: Scenario = {
  name: "network-bug",
  variantDir: "evals/sample-app-variants/network-bug/dist",
  prompt: PROMPT,
  oracle,
  oracleMinimumToolCalls: 5,
};
