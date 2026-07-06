// Scenario: node-stdio-bug — the L4 coverage gap for `get_node_output`.
//
// The Node fixture (examples/sample-node-app/src/stdio-bug.ts) sums an
// input array but the accumulator adds `v + 1` per iteration instead
// of `v`, so the printed total is wrong. Critically the value is
// emitted via `process.stdout.write(...)` — NOT `console.log` — so
// V8's Runtime.consoleAPICalled stream (`get_console_logs`) never sees
// it. The only way to observe the printed value is `get_node_output`,
// which buffers the raw OS pipe.
//
// This is the only scenario in the suite where `get_node_output` is
// load-bearing for mechanic=1. An agent that reaches for the wrong
// console tool, or that pauses at a breakpoint and reads the
// accumulator from scope without ever looking at stdout, gets
// mechanic=0. The whole point is to verify the agent learns the
// raw-stdio channel-separation contract documented in
// src/tools/node-output.ts.
//
// Canonical workflow:
//   launch_node → set_breakpoint(stdio-bug.ts) → resume past entry pause →
//   wait_for_pause (bp hit) → get_node_output (raw stdout has flushed by
//   then) → inspect (get_call_stack / get_scope / evaluate) → resume →
//   final answer naming stdio-bug.ts + line 12 / `accumulate` / the +1 bug.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: a Node script computes a running total over an input array and prints the result to stdout, but the printed value is wrong. Discover what value was actually printed (use the tool that captures the script's raw stdout — note that this script prints via process.stdout.write, not console.log), then set a breakpoint inside the accumulator, drive the script to pause there, inspect the paused state, and diagnose the bug. Report the bug as file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC: agent must have observed raw stdout. Just calling
  // get_node_output successfully isn't enough — if called before
  // process.stdout.write flushes (e.g. while paused inside accumulate),
  // `items` is empty (or only carries stderr from the inspector
  // banner). Require a stdout item whose text mentions "total" — the
  // printed prefix from stdio-bug.ts's process.stdout.write call.
  const observedRawStdout = calls.some(
    (c) =>
      c.tool === "get_node_output" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      Array.isArray((c.output as { items?: unknown }).items) &&
      ((c.output as { items: unknown[] }).items as Array<{ stream?: unknown; text?: unknown }>).some(
        (item) =>
          item?.stream === "stdout" &&
          typeof item?.text === "string" &&
          /total\b/i.test(item.text as string),
      ),
  );

  // Build the set of bp ids registered on stdio-bug.ts. Oracle is
  // permissive on the bp line — any line on stdio-bug.ts counts (the
  // bug is on line 12 but lines around it are equally reasonable for an
  // agent triangulating).
  const bpIdsOnFile = new Set<string>();
  for (const c of calls) {
    if (
      c.tool === "set_breakpoint" &&
      !c.isError &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("stdio-bug.ts") &&
      typeof c.output === "object" &&
      c.output !== null
    ) {
      const id = (c.output as { id?: unknown }).id;
      if (typeof id === "string") bpIdsOnFile.add(id);
    }
  }
  const breakpointOk = bpIdsOnFile.size > 0;

  // bp hit is verified via hit_breakpoint_ids containing one of OUR bp
  // ids — never via `reason` equality. V8 emits non-standard reason
  // strings on Node (see test/e2e/node-breakpoint-flow.e2e.test.ts:12-21
  // for the rationale). Using findIndex (not .some) so we can require
  // inspection AFTER this point in the trace — mirrors worker-bug.ts:65-77.
  const bpHitIdx = calls.findIndex(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      Array.isArray((c.output as { hit_breakpoint_ids?: unknown }).hit_breakpoint_ids) &&
      ((c.output as { hit_breakpoint_ids: unknown[] }).hit_breakpoint_ids as unknown[]).some(
        (id) => typeof id === "string" && bpIdsOnFile.has(id),
      ),
  );
  const bpHit = bpHitIdx >= 0;

  // Inspection (get_call_stack/get_scope/evaluate) must happen AFTER
  // the bp hit. A successful inspection during the entry pause (before
  // bp hit) doesn't prove the agent inspected the paused state at the
  // bug — same gaming pattern called out in worker-bug.ts.
  const inspectedAfterBpHit =
    bpHit &&
    calls
      .slice(bpHitIdx + 1)
      .some(
        (c) =>
          !c.isError &&
          ["get_call_stack", "get_scope", "evaluate"].includes(c.tool),
      );

  const mechanic: 0 | 1 =
    observedRawStdout && breakpointOk && bpHit && inspectedAfterBpHit ? 1 : 0;

  // CORRECTNESS — final answer must name stdio-bug.ts AND either the bug
  // line (12), the `accumulate` function symbol, or the +1/off-by-one bug
  // fact. Mirrors compute-step's "line OR symbol" tolerance (compute-step
  // accepts either `handlers.ts:12` or naming `computeStep`).
  const fa = finalAnswer.toLowerCase();
  const mentionsFile = /stdio-bug\.ts/i.test(finalAnswer);
  const mentionsBugLine = /\b12\b/.test(finalAnswer);
  const mentionsBugFact =
    /accumulate|total\s*\+=?\s*v\s*\+\s*1|\+\s*1\b|extra\s+(\+?\s*1|one)|off[\s-]by[\s-]one/i.test(
      fa,
    );
  const correctness: 0 | 1 =
    mentionsFile && (mentionsBugLine || mentionsBugFact) ? 1 : 0;

  const why: string[] = [];
  if (!observedRawStdout)
    why.push(
      "mechanic: no get_node_output result containing the printed 'total: ...' stdout line (raw stdout never observed or called before stdout flushed)",
    );
  if (!breakpointOk) why.push("mechanic: no set_breakpoint on stdio-bug.ts");
  if (!bpHit)
    why.push(
      "mechanic: no wait_for_pause whose hit_breakpoint_ids contains a bp on stdio-bug.ts",
    );
  if (bpHit && !inspectedAfterBpHit)
    why.push(
      "mechanic: no successful inspection (get_call_stack/get_scope/evaluate) AFTER the bp hit",
    );
  if (!mentionsFile) why.push("correctness: final answer does not mention stdio-bug.ts");
  if (mentionsFile && !mentionsBugLine && !mentionsBugFact)
    why.push(
      "correctness: final answer mentions the file but not the line (12), the `accumulate` symbol, or the +1 bug fact",
    );

  const summary = `node-stdio-bug correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0, // grader derives from oracleMinimumToolCalls
    recovery: 0, // grader derives
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — get_node_output read raw stdout, bp/pause/inspect cycle exercised, bug named`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const nodeStdioBug: Scenario = {
  name: "node-stdio-bug",
  target: { kind: "node", script: "examples/sample-node-app/dist/stdio-bug.js" },
  prompt: PROMPT,
  oracle,
  // Hand-trace: launch_node + set_breakpoint + resume (past entry pause) +
  // wait_for_pause + get_node_output + inspect + resume + terminal close ≈ 8.
  // get_node_output is the marginal call that pushes this above
  // compute-step's 7-floor.
  oracleMinimumToolCalls: 8,
};
