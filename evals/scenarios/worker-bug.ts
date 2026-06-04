// Scenario: worker-bug — variant computes the wrong value INSIDE a
// Web Worker.
//
// The bug is in worker.ts, which runs in a separate target with its
// own CDP session. The agent must:
//   1. Discover the worker target (list_targets / list_scripts).
//   2. Set a breakpoint in worker.ts (source-map resolution into the
//      child session).
//   3. Pause inside the worker — which requires routing pause/
//      set_breakpoint via session_id, since CDP scriptIds are scoped
//      per-session.
//   4. Inspect the worker's scope; report the bug.
//
// This is the highest-value scenario per the rev-6 plan: the entire
// multi-session compound-key plumbing exists to support this case.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: verify multi-session debug routing into a Web Worker child session. The page spawns a worker that returns a wrong computed value after clicking "Go". Discover the worker target (list_targets or list_scripts), set a breakpoint in worker.ts, drive the page to trigger it, and observe a pause routed through the worker's session (the response's session_id field will be non-null — that's how you know the multi-session plumbing worked). Inspect the worker's scope and report file:line.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // MECHANIC checks — agent discovered the worker, set bp inside, paused
  // in the child session (the load-bearing multi-session check).
  const discoveredWorker = calls.some(
    (c) =>
      (c.tool === "list_targets" || c.tool === "list_scripts") &&
      !c.isError &&
      Array.isArray(c.output) &&
      (c.output as Array<{ url?: string; type?: string; original_sources?: string[] }>).some(
        (t) =>
          t.type === "worker" ||
          t.type === "shared_worker" ||
          (t.original_sources ?? []).some((s) => s.endsWith("worker.ts")),
      ),
  );
  const breakpointInWorker = calls.some(
    (c) =>
      c.tool === "set_breakpoint" &&
      typeof c.input === "object" &&
      c.input !== null &&
      String((c.input as { file?: unknown }).file ?? "").endsWith("worker.ts"),
  );
  // Locate the first successful pause routed to a non-root session — the
  // worker pause. Using findIndex (not .some) so we can require subsequent
  // inspection AFTER this point in the trace, not anywhere.
  const workerPauseIdx = calls.findIndex(
    (c) =>
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      ((c.output as { session_id?: unknown }).session_id ?? null) !== null,
  );
  const pausedInWorker = workerPauseIdx >= 0;

  // The prompt directs the agent to inspect the worker's scope. Must be:
  // (a) AFTER the worker pause (a pre-pause get_scope that errors with
  // not_paused doesn't count), and (b) a successful call (!isError). The
  // previous version of this check was a naive `calls.some` over the
  // whole trace and admitted both of those gaming patterns — see PR #38
  // GPT-5 follow-up review.
  const inspectedAfterWorkerPause =
    pausedInWorker &&
    calls
      .slice(workerPauseIdx + 1)
      .some(
        (c) =>
          !c.isError &&
          ["get_call_stack", "get_scope", "evaluate", "get_object_properties"].includes(c.tool),
      );
  const mechanic: 0 | 1 =
    discoveredWorker && breakpointInWorker && pausedInWorker && inspectedAfterWorkerPause
      ? 1
      : 0;

  // CORRECTNESS check — answer must name the actual bug (`doubleIt` or
  // `n * 3` / `* 3`), not just parrot the word "worker" which is all
  // over the prompt. Mentioning worker.ts is required (location); the
  // bug specifics (function name OR the wrong computation) prove the
  // agent inspected the actual code, not the prompt (PR #38 GPT-5 review).
  const mentionsWorkerFile = /worker\.ts/i.test(finalAnswer);
  const mentionsBugFact = /doubleit|n\s*\*\s*3|\*\s*3\b|tripl(e|ed|es|ing)|times\s+3|by\s+3/i.test(
    finalAnswer,
  );
  const correctness: 0 | 1 = mentionsWorkerFile && mentionsBugFact ? 1 : 0;

  const why: string[] = [];
  if (!discoveredWorker) why.push("mechanic: agent didn't discover the worker target/script");
  if (!breakpointInWorker) why.push("mechanic: no breakpoint set in worker.ts");
  if (!pausedInWorker) why.push("mechanic: no pause routed to a non-null session_id");
  if (pausedInWorker && !inspectedAfterWorkerPause)
    why.push(
      "mechanic: no successful inspection (get_scope/evaluate/get_object_properties) AFTER the worker pause",
    );
  if (!mentionsWorkerFile) why.push("correctness: answer doesn't mention worker.ts");
  if (!mentionsBugFact)
    why.push("correctness: answer doesn't name the bug fact (doubleIt or n*3 / tripling)");

  const summary = `worker-bug correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: discovered worker, set bp inside, paused in child session`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const workerBug: Scenario = {
  name: "worker-bug",
  variantDir: "evals/sample-app-variants/worker-bug/dist",
  prompt: PROMPT,
  oracle,
  // Add list_scripts / list_targets to the compute-step recipe = ~8.
  oracleMinimumToolCalls: 8,
};
