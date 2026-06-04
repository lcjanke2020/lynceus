import { describe, it, expect } from "vitest";
import { workerBug } from "./worker-bug.js";
import { pair } from "./_test-helpers.js";

describe("worker-bug oracle", () => {
  // ANSWER must name the actual bug fact (doubleIt or n*3) AND worker.ts —
  // see oracle's correctness predicate. A vague "worker compute is wrong"
  // would parrot the prompt without proving the agent saw the code.
  const ANSWER =
    "Bug: src/worker.ts:19 — doubleIt(n) returns n * 3 instead of n * 2 (tripling the input).";

  it("passes both axes when the agent discovered the worker, set bp inside, paused in child session, and inspected", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "list_scripts", {}, [
        { url: "http://x/main.js", session_id: null, original_sources: ["src/main.ts"] },
        {
          url: "http://x/worker.js",
          session_id: "SW1",
          original_sources: ["src/worker.ts"],
        },
      ]),
      ...pair("4", "set_breakpoint", { file: "worker.ts", line: 5 }, { id: "bp" }),
      ...pair("5", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("6", "wait_for_pause", {}, { reason: "other", session_id: "SW1", call_stack: [] }),
      ...pair("7", "get_scope", {}, { items: [] }),
      ...pair("8", "resume", {}, "resumed"),
    ];
    const out = workerBug.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("passes both axes when discovery came via list_targets with type=worker", () => {
    const trace = [
      ...pair("1", "list_targets", {}, [
        { id: "T1", type: "page" },
        { id: "T2", type: "worker", url: "http://x/worker.js" },
      ]),
      ...pair("2", "set_breakpoint", { file: "worker.ts", line: 5 }, { id: "bp" }),
      ...pair("3", "click", {}, {}),
      ...pair("4", "wait_for_pause", {}, { session_id: "SW1", call_stack: [] }),
      ...pair("5", "get_scope", {}, { items: [] }),
    ];
    const out = workerBug.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
  });

  it("fails mechanic when inspection happened BEFORE the worker pause (not 'at pause')", () => {
    // Regression for PR #38 GPT-5 follow-up: the previous naive
    // calls.some predicate would have passed mechanic here because a
    // pre-pause get_scope (which errors with not_paused) plus full
    // discovery + bp + non-root pause + no post-pause inspection still
    // satisfied "an inspection tool name appeared in the trace." The
    // fixed predicate requires ordering AFTER the pause AND !isError.
    const trace = [
      ...pair("1", "get_scope", {}, { error: "not_paused" }, true, "not_paused"),
      ...pair("2", "list_targets", {}, [
        { id: "T2", type: "worker", url: "http://x/worker.js" },
      ]),
      ...pair("3", "set_breakpoint", { file: "worker.ts", line: 5 }, { id: "bp" }),
      ...pair("4", "click", {}, {}),
      ...pair("5", "wait_for_pause", {}, { session_id: "SW1", call_stack: [] }),
      // No successful inspection AFTER the pause.
    ];
    const out = workerBug.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful inspection.*AFTER the worker pause/);
  });

  it("fails mechanic when the agent paused in the worker but skipped inspection", () => {
    // Discovery ✓, bp ✓, pause-with-session_id ✓, but no get_scope/evaluate —
    // the prompt directs "inspect its scope" so this should fail mechanic
    // even though all other workflow steps fired (GPT-5 review of PR #38).
    const trace = [
      ...pair("1", "list_targets", {}, [
        { id: "T2", type: "worker", url: "http://x/worker.js" },
      ]),
      ...pair("2", "set_breakpoint", { file: "worker.ts", line: 5 }, { id: "bp" }),
      ...pair("3", "click", {}, {}),
      ...pair("4", "wait_for_pause", {}, { session_id: "SW1", call_stack: [] }),
      // No get_scope / evaluate — bug "inspected" only via source-reading.
    ];
    const out = workerBug.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no successful inspection.*AFTER the worker pause/);
  });

  it("fails mechanic when no worker was discovered (answer-correctness still ok)", () => {
    const trace = [
      ...pair("1", "list_scripts", {}, [
        { url: "http://x/main.js", session_id: null, original_sources: ["src/main.ts"] },
      ]),
      ...pair("2", "set_breakpoint", { file: "main.ts", line: 1 }, { id: "bp" }),
      ...pair("3", "click", {}, {}),
      ...pair("4", "wait_for_pause", {}, { session_id: null, call_stack: [] }),
    ];
    const out = workerBug.oracle(trace, ANSWER);
    // ANSWER mentions worker.ts → correctness=1, but workflow missed → mechanic=0.
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when the pause was in the root session, not the worker", () => {
    const trace = [
      ...pair("1", "list_scripts", {}, [
        { url: "http://x/worker.js", session_id: "SW1", original_sources: ["src/worker.ts"] },
      ]),
      ...pair("2", "set_breakpoint", { file: "worker.ts", line: 5 }, { id: "bp" }),
      ...pair("3", "click", {}, {}),
      // Wrong session_id — pause landed in root, not the worker
      ...pair("4", "wait_for_pause", {}, { session_id: null, call_stack: [] }),
    ];
    const out = workerBug.oracle(trace, ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/non-null session_id/);
  });
});
