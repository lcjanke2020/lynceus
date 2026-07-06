// Unit tests for the node-uncaught-throw oracle.
//
// Three required cases per the scenario spec:
//   (a) clean first-try pass — no entry-pause-vs-throw race,
//   (b) resume-too-soon → re-launch → pass with recovery > 0,
//   (c) never reached the paused-on-exception state → mechanic=0.
//
// Plus the usual correctness/mechanic edge cases mirroring the sibling
// node scenarios (node-compute-step.test.ts, node-stdio-bug.test.ts).
//
// The oracle is pure: (trace, finalAnswer) -> OracleResult. Feed it
// synthetic traces and assert the verdict. Recovery counting is the
// grader's job (grader.ts:38-60); it is not exercised here because
// the oracle returns 0 unconditionally on that axis. The re-launch
// case (b) instead asserts mechanic=1 + correctness=1 to prove the
// oracle does NOT lock ordering.

import { describe, it, expect } from "vitest";
import { nodeUncaughtThrow } from "./node-uncaught-throw.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

/** Canonical clean trace: launch → set_pause_on_exceptions at entry →
 *  resume → wait_for_pause (exception) → get_call_stack → resume. */
function cleanPassTrace(state: "all" | "uncaught" = "all"): TraceEntry[] {
  return [
    ...pair(
      "1",
      "launch_node",
      { script: "examples/sample-node-app/dist/throw.js" },
      { sessionId: "S1", pid: 12345 },
    ),
    ...pair(
      "2",
      "wait_for_pause",
      { timeout_ms: 10000 },
      { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
    ),
    ...pair(
      "3",
      "set_pause_on_exceptions",
      { state },
      { state, sessions_applied: 1, failures: [] },
    ),
    ...pair("4", "resume", {}, "resumed"),
    ...pair(
      "5",
      "wait_for_pause",
      { timeout_ms: 10000 },
      {
        reason: "exception",
        hit_breakpoint_ids: [],
        call_stack: [
          { file: "throw.ts", line: 8, function_name: "processItem" },
          { file: "throw.ts", line: 14, function_name: "main" },
        ],
      },
    ),
    ...pair("6", "get_call_stack", {}, [
      { file: "throw.ts", line: 8, function_name: "processItem" },
      { file: "throw.ts", line: 14, function_name: "main" },
    ]),
    ...pair("7", "resume", {}, "resumed"),
  ];
}

describe("node-uncaught-throw oracle", () => {
  it("passes when the agent installs pause-on-exceptions, observes reason='exception', inspects, and names throw.ts:8 + null deref", () => {
    const trace = cleanPassTrace();
    const finalAnswer =
      "Bug in throw.ts:8 — `return item!.foo;` throws a TypeError when `item` is null on the second iteration.";
    const out = nodeUncaughtThrow.oracle(trace, finalAnswer);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("accepts state='uncaught' (oracle is permissive about which of {'all','uncaught'} the agent picked)", () => {
    const trace = cleanPassTrace("uncaught");
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem dereferences a null item.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("passes the resume-too-soon → re-launch → success recovery path with mechanic=1 (oracle does NOT lock ordering)", () => {
    // First attempt: launch, resume the entry pause WITHOUT installing
    // pause-on-exceptions, then try wait_for_pause — script has already
    // thrown and exited, so the call errors with session_closed (or
    // similar). The agent then re-launches, installs pause-on-exceptions
    // at the entry pause this time, resumes, observes the exception
    // pause, inspects, done.
    const trace: TraceEntry[] = [
      // First attempt — wrong order.
      ...pair(
        "1",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S1", pid: 11111 },
      ),
      ...pair("2", "resume", {}, "resumed"),
      ...pair(
        "3",
        "wait_for_pause",
        { timeout_ms: 5000 },
        { error: "session_closed", code: "session_closed" },
        true,
        "session_closed",
      ),
      // Re-launch and do it the right way.
      ...pair(
        "4",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S2", pid: 22222 },
      ),
      ...pair(
        "5",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair(
        "6",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      ...pair("7", "resume", {}, "resumed"),
      ...pair(
        "8",
        "wait_for_pause",
        { timeout_ms: 10000 },
        {
          reason: "exception",
          hit_breakpoint_ids: [],
          call_stack: [
            { file: "throw.ts", line: 8, function_name: "processItem" },
            { file: "throw.ts", line: 14, function_name: "main" },
          ],
        },
      ),
      ...pair(
        "9",
        "get_scope",
        { scope_type: "local" },
        { items: [{ name: "item", value: null, type: "null" }] },
      ),
      ...pair("10", "resume", {}, "resumed"),
    ];
    const out = nodeUncaughtThrow.oracle(
      trace,
      "Bug is in throw.ts:8 — `return item!.foo;` in processItem throws because `item` is null on the second iteration.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("fails mechanic when the agent never reached the paused-on-exception state (resumed but never re-paused)", () => {
    // Agent installed pause-on-exceptions but only ever observed the
    // entry pause (or no pause at all). reason="exception" never landed.
    const trace: TraceEntry[] = [
      ...pair(
        "1",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S1", pid: 12345 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair(
        "3",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      // No second wait_for_pause with reason="exception" — agent gave up.
      ...pair("4", "get_call_stack", {}, []),
    ];
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no wait_for_pause returned reason="exception"/);
  });

  it("fails mechanic when set_pause_on_exceptions was called with state='none' (turning off, not on)", () => {
    const trace = cleanPassTrace().map((e) => {
      if (e.t === "tool_call" && e.toolUseId === "3") {
        return { ...e, input: { state: "none" } };
      }
      if (e.t === "tool_result" && e.toolUseId === "3") {
        return {
          ...e,
          output: { state: "none", sessions_applied: 1, failures: [] },
        };
      }
      return e;
    });
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful set_pause_on_exceptions/);
  });

  it("fails mechanic when set_pause_on_exceptions was never called at all", () => {
    // Agent observed an exception pause through some other route (the
    // L4 oracle is permissive about HOW the pause was reached, but
    // set_pause_on_exceptions is still the gate for "agent exercised
    // the exception workflow").
    const trace = cleanPassTrace().filter(
      (e) => !((e.t === "tool_call" || e.t === "tool_result") && e.toolUseId === "3"),
    );
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful set_pause_on_exceptions/);
  });

  it("fails mechanic when the only inspection happened BEFORE the exception pause (e.g. against the entry pause)", () => {
    // Pre-bp pattern from worker-bug:65-77 — agent inspected during the
    // entry pause, then resumed, observed the exception pause, but never
    // inspected the exception frame. Mechanic must require inspection
    // AFTER reason="exception" appeared.
    const trace: TraceEntry[] = [
      ...pair(
        "1",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S1", pid: 12345 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair("3", "get_call_stack", {}, []), // inspection during entry pause
      ...pair(
        "4",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      ...pair("5", "resume", {}, "resumed"),
      ...pair(
        "6",
        "wait_for_pause",
        { timeout_ms: 10000 },
        {
          reason: "exception",
          hit_breakpoint_ids: [],
          call_stack: [{ file: "throw.ts", line: 8, function_name: "processItem" }],
        },
      ),
      // No inspection after the exception pause.
      ...pair("7", "resume", {}, "resumed"),
    ];
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(
      /no successful inspection .* between the exception pause and the next resume/,
    );
  });

  it("fails mechanic when inspection happens AFTER the exception pause but only after a subsequent resume/close/relaunch (from upstream review)", () => {
    // Exception pause → resume → close_session → re-launch → wait_for_pause
    // (entry on the new session) → get_scope. The agent ended up
    // inspecting the second session's entry pause, not the exception
    // frame. Previously this passed mechanic because the inspection
    // window was unbounded; now the window is capped at the next
    // resume/close_session/launch_node.
    const trace: TraceEntry[] = [
      ...pair(
        "1",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S1", pid: 11111 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair(
        "3",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        { timeout_ms: 10000 },
        {
          reason: "exception",
          hit_breakpoint_ids: [],
          call_stack: [{ file: "throw.ts", line: 8, function_name: "processItem" }],
        },
      ),
      // Window-terminating call BEFORE any inspection.
      ...pair("6", "resume", {}, "resumed"),
      ...pair("7", "close_session", {}, "closed"),
      ...pair(
        "8",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S2", pid: 22222 },
      ),
      ...pair(
        "9",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair("10", "get_scope", {}, { items: [] }), // inspects the second entry pause, not the exception
    ];
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(
      /no successful inspection .* between the exception pause and the next resume/,
    );
  });

  it("passes when the FIRST exception pause was not inspected but a SECOND one (after re-launch) was (from upstream review)", () => {
    // The re-launch recovery contract: any tool ordering that ENDS IN
    // a paused-on-exception state with inspection earns mechanic=1,
    // even if an earlier exception pause was abandoned (agent panicked
    // and resumed without inspecting, then re-launched). Anchoring on
    // findIndex(first exception pause) would fail this trace because
    // the #1 window ends at the immediate resume with no inspection.
    // The fix iterates over EVERY exception-pause index and accepts if
    // ANY window contains a valid inspection.
    const trace: TraceEntry[] = [
      // First attempt — reach exception pause but resume without inspecting.
      ...pair(
        "1",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S1", pid: 11111 },
      ),
      ...pair(
        "2",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair(
        "3",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      ...pair("4", "resume", {}, "resumed"),
      ...pair(
        "5",
        "wait_for_pause",
        { timeout_ms: 10000 },
        {
          reason: "exception",
          hit_breakpoint_ids: [],
          call_stack: [{ file: "throw.ts", line: 8, function_name: "processItem" }],
        },
      ),
      // Agent panicked / didn't realize they were paused — resume without inspecting.
      ...pair("6", "resume", {}, "resumed"),
      ...pair("7", "close_session", {}, "closed"),
      // Re-launch and do it the right way this time.
      ...pair(
        "8",
        "launch_node",
        { script: "examples/sample-node-app/dist/throw.js" },
        { sessionId: "S2", pid: 22222 },
      ),
      ...pair(
        "9",
        "wait_for_pause",
        { timeout_ms: 10000 },
        { reason: "Break on start", hit_breakpoint_ids: [], call_stack: [] },
      ),
      ...pair(
        "10",
        "set_pause_on_exceptions",
        { state: "all" },
        { state: "all", sessions_applied: 1, failures: [] },
      ),
      ...pair("11", "resume", {}, "resumed"),
      ...pair(
        "12",
        "wait_for_pause",
        { timeout_ms: 10000 },
        {
          reason: "exception",
          hit_breakpoint_ids: [],
          call_stack: [{ file: "throw.ts", line: 8, function_name: "processItem" }],
        },
      ),
      // Inspection inside the SECOND exception pause's window — must
      // pass mechanic even though the FIRST window was empty.
      ...pair(
        "13",
        "get_scope",
        { scope_type: "local" },
        { items: [{ name: "item", value: null, type: "null" }] },
      ),
      ...pair("14", "resume", {}, "resumed"),
    ];
    const out = nodeUncaughtThrow.oracle(
      trace,
      "Bug in throw.ts:8 — processItem null deref, `item` is null on the second iteration.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("fails mechanic when set_pause_on_exceptions returned sessions_applied=0 (e.g. CDP call rejected on every attached session)", () => {
    // The handler at src/tools/breakpoints.ts:173-186 uses
    // Promise.allSettled and returns {sessions_applied, failures} even
    // when every CDP call rejected — `isError` stays false. Without the
    // structured check, this trace would earn mechanic credit despite
    // pause-on-exceptions never actually applying (caught in upstream
    // review).
    const trace = cleanPassTrace().map((e) => {
      if (e.t === "tool_result" && e.toolUseId === "3") {
        return {
          ...e,
          output: {
            state: "all",
            sessions_applied: 0,
            failures: [
              { sid: "__root__", error: "Some CDP transport error" },
            ],
          },
        };
      }
      return e;
    });
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/sessions_applied > 0/);
  });

  it("fails mechanic when set_pause_on_exceptions reported a non-empty failures list (partial apply)", () => {
    // sessions_applied > 0 but failures.length > 0 — at least one
    // attached session rejected. The L4 gate considers this not-fully-
    // applied and rejects mechanic to match the "successful" prose.
    const trace = cleanPassTrace().map((e) => {
      if (e.t === "tool_result" && e.toolUseId === "3") {
        return {
          ...e,
          output: {
            state: "all",
            sessions_applied: 1,
            failures: [{ sid: "child-1", error: "child detached" }],
          },
        };
      }
      return e;
    });
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — processItem null deref.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/sessions_applied > 0/);
  });

  it("fails correctness when the answer doesn't mention throw.ts", () => {
    const trace = cleanPassTrace();
    const out = nodeUncaughtThrow.oracle(
      trace,
      "There's a null reference somewhere in processItem.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/doesn't mention throw.ts/);
  });

  it("fails correctness when the answer mentions the file but neither the line (8) nor the processItem symbol", () => {
    const trace = cleanPassTrace();
    const out = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts dereferences something null but I can't pinpoint where.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/line 8 or the processItem symbol/);
  });

  it("fails correctness when the answer names file + line but not the null-deref nature", () => {
    const trace = cleanPassTrace();
    const out = nodeUncaughtThrow.oracle(
      trace,
      "There's a bug on throw.ts:8 — just generally broken.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/null-deref nature/);
  });

  it("accepts the processItem symbol as a substitute for the line number in correctness", () => {
    const trace = cleanPassTrace();
    const out = nodeUncaughtThrow.oracle(
      trace,
      "Bug is in throw.ts inside processItem — `item` can be null and `.foo` throws a TypeError.",
    );
    expect(out.correctness).toBe(1);
  });

  it("accepts 'cannot read' / 'TypeError' / 'second iteration' phrasings as the null-deref signal", () => {
    const trace = cleanPassTrace();
    const cannotRead = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts:8 — TypeError: cannot read property 'foo' on the second iteration.",
    );
    expect(cannotRead.correctness).toBe(1);
    const secondIter = nodeUncaughtThrow.oracle(
      trace,
      "throw.ts processItem dereferences item on the second iteration where item is bound to a falsy reference.",
    );
    expect(secondIter.correctness).toBe(1);
  });

  it("rejects an answer that names only line 7 (function declaration) without the processItem symbol (from upstream review)", () => {
    // Line 7 is `function processItem(item: ... | null): string {` — the
    // declaration, not the throwing statement on line 8. Accepting "7"
    // risks false-positive on a hallucinated location. The symbol
    // fallback (processItem) is intentionally NOT in this string so the
    // gate is testing the line-number axis in isolation.
    const trace = cleanPassTrace();
    const out = nodeUncaughtThrow.oracle(
      trace,
      "Bug in throw.ts:7 — null deref of `.foo` somewhere in there.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/line 8 or the processItem symbol/);
  });
});
