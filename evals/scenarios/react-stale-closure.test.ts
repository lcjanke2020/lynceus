import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../harness/types.js";
import { pair } from "./_test-helpers.js";
import { reactStaleClosure } from "./react-stale-closure.js";

const GOOD_ANSWER =
  "StaleCounter.tsx:8 has a stale closure: the useEffect interval captures the initial count because its dependency array is empty. The React State hook was frozen at 1.";

function successfulTrace(): TraceEntry[] {
  return [
    ...pair(
      "attach",
      "attach_react_devtools",
      {},
      { framework: "react", status: "attached" },
    ),
    ...pair(
      "find",
      "find_react_component",
      { name: "StaleCounter", exact: true },
      {
        total_matches: 1,
        matches: [
          { component_id: 2, renderer_id: 1, display_name: "StaleCounter" },
        ],
      },
    ),
    ...pair(
      "inspect",
      "inspect_react_component",
      { component_id: 2, renderer_id: 1 },
      {
        display_name: "StaleCounter",
        hooks: {
          data: [
            { id: 0, name: "State", value: 1 },
            { id: 1, name: "Effect" },
          ],
        },
      },
    ),
  ];
}

describe("react-stale-closure oracle", () => {
  it("passes only when the bridge result proves the frozen State hook", () => {
    const out = reactStaleClosure.oracle(successfulTrace(), GOOD_ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/State=1/);
  });

  it("keeps source correctness independent from React-tool adoption", () => {
    const out = reactStaleClosure.oracle([], GOOD_ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("does not credit an inspection whose State value is not frozen at 1", () => {
    const trace = successfulTrace().map((entry) =>
      entry.t === "tool_result" && entry.toolUseId === "inspect"
        ? {
            ...entry,
            output: {
              display_name: "StaleCounter",
              hooks: { data: [{ name: "State", value: 0 }] },
            },
          }
        : entry,
    );
    const out = reactStaleClosure.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/State=1/);
  });

  it("does not credit a successful inspection of the wrong component", () => {
    const trace = successfulTrace().map((entry) =>
      entry.t === "tool_result" && entry.toolUseId === "inspect"
        ? {
            ...entry,
            output: {
              display_name: "OtherCounter",
              hooks: { data: [{ name: "State", value: 1 }] },
            },
          }
        : entry,
    );
    expect(reactStaleClosure.oracle(trace, GOOD_ANSWER).mechanic).toBe(0);
  });

  it("does not count errored locate/inspect calls as mechanic evidence", () => {
    const trace: TraceEntry[] = [
      ...pair(
        "attach",
        "attach_react_devtools",
        {},
        { framework: "react", status: "attached" },
      ),
      ...pair(
        "find",
        "find_react_component",
        { name: "StaleCounter" },
        { error: "no_react_bridge" },
        true,
        "no_react_bridge",
      ),
      ...pair(
        "inspect",
        "inspect_react_component",
        { component_id: 2 },
        { error: "react_component_not_found" },
        true,
        "react_component_not_found",
      ),
    ];
    expect(reactStaleClosure.oracle(trace, GOOD_ANSWER).mechanic).toBe(0);
  });

  it("rejects raw evaluate access to React internals from the mechanic", () => {
    const trace = [
      ...successfulTrace(),
      ...pair(
        "bypass",
        "evaluate",
        { expression: "window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers" },
        { value: {} },
      ),
    ];
    const out = reactStaleClosure.oracle(trace, GOOD_ANSWER);
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/raw evaluate/);
  });

  it("rejects a vague effect answer without the stale-capture dependency cause", () => {
    const out = reactStaleClosure.oracle(
      successfulTrace(),
      "StaleCounter.tsx has a useEffect interval that should be investigated.",
    );
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/stale captured count|dependency\/updater/);
  });

  it("uses a managed development browser target and defensively xfails mechanic", () => {
    expect(reactStaleClosure.target).toEqual({
      kind: "browser",
      webAppDir: "examples/sample-fullstack-app",
      webUrl: "http://127.0.0.1:5173/?rdt_scenario=stale-closure",
    });
    expect(reactStaleClosure.xfailMechanic).toBe(true);
    expect(reactStaleClosure.xfailCorrectness).toBeUndefined();
  });
});
