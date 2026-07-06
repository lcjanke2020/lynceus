// Scenario: node-uncaught-throw — exception-pause flow on Node, with
// the entry-pause-vs-throw race the browser side doesn't have.
//
// Fixture: examples/sample-node-app/src/throw.ts loops two items
// `[{ foo: "ok" }, null]` through `processItem(item)` and dereferences
// `item!.foo` on the offending second iteration, throwing a TypeError
// that no upstream user code catches.
//
// Canonical workflow (one path — the L4 oracle deliberately doesn't
// lock it):
//   launch_node (entry pause active) → set_pause_on_exceptions
//   ({state:"all"} OR {state:"uncaught"}) → resume → wait_for_pause
//   (reason="exception") → get_call_stack / get_scope / evaluate →
//   resume / close_session → final answer naming throw.ts + the
//   offending line + the null-deref nature of the bug.
//
// Why the oracle does NOT lock ordering — re-launch recovery is a
// first-class pass:
//   On Node, V8 emits the --inspect-brk entry pause first. An agent
//   who resumes the entry pause BEFORE installing
//   set_pause_on_exceptions races the throw — the process throws and
//   exits before they can re-pause. The recovery path is to re-launch
//   and set pause-on-exceptions before resume the second time. The
//   browser side has no analogue (the DOM doesn't auto-exit on
//   uncaught), so penalizing this would conflate ordering with
//   workflow fluency. We grade the OUTCOME — agent ended up paused on
//   exception and inspected — not the path. The grader's automatic
//   recovery counter (grader.ts:38-60) ticks for free when an erroring
//   call between attempts is followed by a different call, so the
//   recovery story still shows up in the OracleResult.
//
// Why we DO gate on `reason === "exception"` on Node (unlike bp-hit):
//   V8 emits non-standard reason strings on Node for entry pauses
//   ("Break on start") and bp hits, which is why other Node scenarios
//   require `hit_breakpoint_ids` ∋ our_bp_id. Exception pauses are
//   different: `reason="exception"` is the standard CDP value and V8
//   on Node emits it reliably (confirmed against
//   test/e2e/node-exceptions.e2e.test.ts during the L3 e2e batch).
//   The "never rely on reason equality" guidance for Node sessions is
//   scoped to bp-hit + entry pause.
//
// Why we accept BOTH state="all" and state="uncaught":
//   The L3 test had to switch to "all" because Node wraps ESM
//   top-level evaluation in an internal try/catch — V8 sees the
//   upstream handler and classifies synchronous module-level throws as
//   CAUGHT, so "uncaught" never pauses for throw.ts. An empirically-
//   correct agent will discover this and switch to "all"; an agent who
//   only tries "uncaught" but happens to land on an exception pause
//   another way still satisfies the gate. Locking to "all" only would
//   falsely fail an agent who picks the more restrictive option.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `Test plan: a Node TypeScript script throws an uncaught exception while iterating over a small input array. Configure the debugger to pause on exceptions, drive the script to the exception pause, inspect the paused frame to see what value caused the throw, and diagnose the root cause. Report the bug as file:line plus the nature of the bug. Note: on Node with --inspect-brk, the entry pause is active when launch_node returns — you must install pause-on-exceptions before resuming, or the script will throw and the process will exit before you can re-pause; if that happens, re-launch and try again.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace);

  // 1. installedPauseOnExceptions — at least one successful
  //    set_pause_on_exceptions with state != "none". Accept BOTH
  //    "all" and "uncaught" per the L3 ESM-classification note above.
  //    Reject "none" because that's turning the feature off, not on.
  //
  //    Also require the OUTPUT to report a successful apply
  //    (sessions_applied > 0 AND failures.length === 0). The tool's
  //    handler at src/tools/breakpoints.ts:173-186 uses
  //    Promise.allSettled and never throws, so `isError` is structurally
  //    always false — without the structured check, a {sessions_applied:
  //    0, failures: [...]} result would silently earn mechanic credit
  //    even though pause-on-exceptions never actually applied (caught
  //    in upstream review).
  const installedPauseOnExceptions = calls.some((c) => {
    if (c.tool !== "set_pause_on_exceptions" || c.isError) return false;
    const input = c.input as { state?: unknown } | null;
    if (input === null || typeof input !== "object") return false;
    if (input.state !== "all" && input.state !== "uncaught") return false;
    const output = c.output as
      | { sessions_applied?: unknown; failures?: unknown }
      | null;
    if (output === null || typeof output !== "object") return false;
    const sessionsApplied = output.sessions_applied;
    const failures = output.failures;
    return (
      typeof sessionsApplied === "number" &&
      sessionsApplied > 0 &&
      Array.isArray(failures) &&
      failures.length === 0
    );
  });

  // 2. exceptionPauseIndices — EVERY wait_for_pause whose output
  //    reports reason="exception". V8 on Node emits the standard
  //    "exception" string reliably for exception pauses (different
  //    from bp-hit and entry-pause cases — see file header).
  //
  //    Why ALL indices, not just the first (raised in upstream review):
  //    The re-launch recovery path is explicitly first-class per the
  //    scenario spec ("any tool ordering that ENDS IN a paused-on-
  //    exception state earns mechanic=1"). An agent that reaches
  //    exception pause #1, panics / resumes without inspecting, then
  //    re-launches and reaches exception pause #2 and inspects THAT
  //    frame is exactly the recovery flow the spec wants to accept.
  //    Anchoring on `findIndex` (the first pause) would window-fail
  //    such a trace because the #1 window ends at the agent's
  //    immediate resume with no inspection inside it.
  const exceptionPauseIndices: number[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (
      c.tool === "wait_for_pause" &&
      !c.isError &&
      typeof c.output === "object" &&
      c.output !== null &&
      (c.output as { reason?: unknown }).reason === "exception"
    ) {
      exceptionPauseIndices.push(i);
    }
  }
  const exceptionPaused = exceptionPauseIndices.length > 0;

  // 3. inspectedDuringExceptionPause — at least ONE exception-pause
  //    window contains a successful inspection BEFORE the next
  //    pause-window-terminating call (resume / close_session /
  //    launch_node). An inspection that landed during the
  //    --inspect-brk entry pause (which is active when launch_node
  //    returns and admits get_call_stack/get_scope/evaluate without
  //    binding any breakpoint) sits OUTSIDE every exception-pause
  //    window so it correctly fails. Same `slice + findIndex(terminator)`
  //    pattern as node-conditional-bp.ts:130-134's firstHitWindow,
  //    applied to each candidate window.
  const WINDOW_TERMINATORS = new Set(["resume", "close_session", "launch_node"]);
  const inspectedDuringExceptionPause = exceptionPauseIndices.some((idx) => {
    const remaining = calls.slice(idx + 1);
    const terminatorOffset = remaining.findIndex((c) =>
      WINDOW_TERMINATORS.has(c.tool),
    );
    const window =
      terminatorOffset >= 0 ? remaining.slice(0, terminatorOffset) : remaining;
    return window.some(
      (c) =>
        !c.isError &&
        ["get_call_stack", "get_scope", "evaluate"].includes(c.tool),
    );
  });

  const mechanic: 0 | 1 =
    installedPauseOnExceptions && exceptionPaused && inspectedDuringExceptionPause ? 1 : 0;

  // CORRECTNESS — the final answer must:
  //   (a) mention throw.ts (the file)
  //   (b) identify either the offending line (8 — the `return
  //       item!.foo;` line) OR the `processItem` symbol. Line 7 is the
  //       function declaration, not the throwing statement; accepting
  //       it would risk false-positive on a hallucinated location
  //       (raised in upstream review). The symbol
  //       fallback already covers agents who give a function-level
  //       pointer without a specific line.
  //   (c) name the null-deref nature of the bug — accept any of:
  //       `null`, `.foo`, `TypeError`, "cannot read", "null reference",
  //       "null pointer", "deref", "second iteration"
  const fa = finalAnswer.toLowerCase();
  const mentionsFile = /throw\.ts/i.test(finalAnswer);
  const mentionsLineOrSymbol =
    /\b8\b/.test(finalAnswer) || /processitem/i.test(fa);
  const mentionsNullDeref =
    /\bnull\b/i.test(fa) ||
    /\.foo\b/i.test(fa) ||
    /typeerror/i.test(fa) ||
    /cannot\s+read/i.test(fa) ||
    /deref/i.test(fa) ||
    /second\s+iteration/i.test(fa) ||
    /undefined.*foo|foo.*undefined/i.test(fa);
  const correctness: 0 | 1 =
    mentionsFile && mentionsLineOrSymbol && mentionsNullDeref ? 1 : 0;

  const why: string[] = [];
  if (!installedPauseOnExceptions)
    why.push(
      'mechanic: no successful set_pause_on_exceptions with state in {"all","uncaught"} and sessions_applied > 0',
    );
  if (!exceptionPaused)
    why.push('mechanic: no wait_for_pause returned reason="exception"');
  if (exceptionPaused && !inspectedDuringExceptionPause)
    why.push(
      "mechanic: no successful inspection (get_call_stack / get_scope / evaluate) between the exception pause and the next resume / close_session / launch_node",
    );
  if (!mentionsFile) why.push("correctness: answer doesn't mention throw.ts");
  if (mentionsFile && !mentionsLineOrSymbol)
    why.push("correctness: answer doesn't name line 8 or the processItem symbol");
  if (!mentionsNullDeref)
    why.push(
      "correctness: answer doesn't name the null-deref nature of the bug (null / .foo / TypeError / cannot read / second iteration)",
    );

  const summary = `node-uncaught-throw correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0, // grader derives from oracleMinimumToolCalls
    recovery: 0, // grader derives from error-followed-by-different-call pairs
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — pause-on-exceptions installed, exception pause observed, inspection done, null-deref named`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const nodeUncaughtThrow: Scenario = {
  name: "node-uncaught-throw",
  target: { kind: "node", script: "examples/sample-node-app/dist/throw.js" },
  prompt: PROMPT,
  oracle,
  // launch_node + set_pause_on_exceptions + resume + wait_for_pause
  // (exception) + inspect + terminal close ≈ 6. An optional entry-pause
  // wait_for_pause drain adds one but isn't required (the entry pause
  // is already active so set_pause_on_exceptions works without it).
  // Sized to the minimum viable Node exception-debugging session.
  oracleMinimumToolCalls: 6,
};
