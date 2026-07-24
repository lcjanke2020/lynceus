import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../harness/types.js";
import { pair } from "./_test-helpers.js";
import { reactContextProvider } from "./react-context-provider.js";

const PROVIDER_ID = "rdt-inner-123e4567-e89b-12d3-a456-426614174000";
const RELOADED_PROVIDER_ID = "rdt-inner-123e4567-e89b-12d3-a456-426614174001";
const GOOD_ANSWER = `RuntimeThemeBoundary's nearest ThemeContext.Provider supplies theme sepia with providerId ${PROVIDER_ID}, overriding the top-level light value.`;

function successfulTrace(): TraceEntry[] {
  return [
    ...pair(
      "attach",
      "attach_react_devtools",
      {},
      { framework: "react", status: "attached" },
    ),
    ...pair(
      "tree",
      "get_react_tree",
      {},
      {
        roots: [
          {
            display_name: null,
            children: [
              {
                display_name: "ContextProviderScenario",
                children: [{ display_name: "SettingsWidget" }],
              },
            ],
          },
        ],
      },
    ),
    ...pair(
      "inspect",
      "inspect_react_component",
      { component_id: 7, renderer_id: 1 },
      {
        display_name: "SettingsWidget",
        hooks: {
          data: [
            {
              id: 0,
              name: "ThemeContext",
              value: { theme: "sepia", providerId: PROVIDER_ID },
            },
          ],
        },
      },
    ),
  ];
}

describe("react-context-provider oracle", () => {
  it("passes when SettingsWidget inspection yields the exact reported provider value", () => {
    const out = reactContextProvider.oracle(successfulTrace(), GOOD_ANSWER);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
    expect(out.notes).toMatch(/exact nearest-provider value/);
  });

  it("keeps mechanic when the answer reports the wrong providerId, but fails correctness", () => {
    const out = reactContextProvider.oracle(
      successfulTrace(),
      "RuntimeThemeBoundary's provider supplies sepia with providerId rdt-inner-00000000-0000-0000-0000-000000000000.",
    );
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/runtime theme\/providerId pair/);
  });

  it("accepts a value from any successful inspection after a reload", () => {
    const trace = [
      ...successfulTrace(),
      ...pair(
        "inspect-after-reload",
        "inspect_react_component",
        { component_id: 9, renderer_id: 1 },
        {
          display_name: "SettingsWidget",
          hooks: {
            data: [
              {
                name: "ThemeContext",
                value: {
                  theme: "aurora",
                  providerId: RELOADED_PROVIDER_ID,
                },
              },
            ],
          },
        },
      ),
    ];
    const answer = `RuntimeThemeBoundary's nearest provider supplies aurora with providerId ${RELOADED_PROVIDER_ID}.`;

    expect(reactContextProvider.oracle(trace, answer)).toMatchObject({
      correctness: 1,
      mechanic: 1,
    });
    expect(
      reactContextProvider.oracle(
        trace,
        `RuntimeThemeBoundary's nearest provider supplies sepia with providerId ${RELOADED_PROVIDER_ID}.`,
      ),
    ).toMatchObject({ correctness: 0, mechanic: 1 });
  });

  it("does not pass from a hard-coded theme word without bridge-sourced identity", () => {
    const out = reactContextProvider.oracle(
      [],
      "The inner RuntimeThemeBoundary provider probably supplies sepia.",
    );
    expect(out.mechanic).toBe(0);
    expect(out.correctness).toBe(0);
  });

  it("does not credit a context payload returned for the wrong component", () => {
    const trace = successfulTrace().map((entry) =>
      entry.t === "tool_result" && entry.toolUseId === "inspect"
        ? {
            ...entry,
            output: {
              display_name: "RuntimeThemeBoundary",
              hooks: {
                data: [
                  {
                    name: "State",
                    value: { theme: "sepia", providerId: PROVIDER_ID },
                  },
                ],
              },
            },
          }
        : entry,
    );
    expect(reactContextProvider.oracle(trace, GOOD_ANSWER).mechanic).toBe(0);
  });

  it("does not credit a SettingsWidget inspection with no runtime provider marker", () => {
    const trace = successfulTrace().map((entry) =>
      entry.t === "tool_result" && entry.toolUseId === "inspect"
        ? {
            ...entry,
            output: {
              display_name: "SettingsWidget",
              hooks: {
                data: [
                  {
                    name: "ThemeContext",
                    value: { theme: "light", providerId: "outer-static" },
                  },
                ],
              },
            },
          }
        : entry,
    );
    const out = reactContextProvider.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/lacked a runtime rdt-inner/);
  });

  it("rejects raw evaluate access to the React hook even if dedicated calls also succeeded", () => {
    const trace = [
      ...successfulTrace(),
      ...pair(
        "bypass",
        "evaluate",
        { expression: "window.__REACT_DEVTOOLS_GLOBAL_HOOK__" },
        { value: { providerId: PROVIDER_ID } },
      ),
    ];
    const out = reactContextProvider.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/raw evaluate/);
  });

  it.each([
    [
      "fiber expando and memoized props",
      'Object.keys(document.querySelector("#settings-widget")).find((key) => key.startsWith("__reactFiber$")); node.memoizedProps.value.providerId',
    ],
    [
      "props expando",
      'Object.keys(document.body).find((key) => key.startsWith("__reactProps$"))',
    ],
    [
      "container expando",
      'Object.keys(document.querySelector("#root")).find((key) => key.startsWith("__reactContainer$"))',
    ],
    [
      "context memoized value",
      'node.dependencies.firstContext["memoizedValue"].providerId',
    ],
  ])("rejects a raw DOM-to-fiber bypass via %s", (_name, expression) => {
    const trace = [
      ...successfulTrace(),
      ...pair("bypass", "evaluate", { expression }, { value: PROVIDER_ID }),
    ];

    expect(reactContextProvider.oracle(trace, GOOD_ANSWER)).toMatchObject({
      correctness: 0,
      mechanic: 0,
    });
  });

  it("allows ordinary read-only DOM evaluation", () => {
    const trace = [
      ...successfulTrace(),
      ...pair(
        "dom-read",
        "evaluate",
        {
          expression:
            'document.querySelector("#settings-widget")?.getAttribute("data-theme")',
        },
        { value: "sepia" },
      ),
    ];

    expect(reactContextProvider.oracle(trace, GOOD_ANSWER)).toMatchObject({
      correctness: 1,
      mechanic: 1,
    });
  });

  it("requires the provider component as well as the exact runtime values", () => {
    const out = reactContextProvider.oracle(
      successfulTrace(),
      `The theme is sepia and the providerId is ${PROVIDER_ID}.`,
    );
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/RuntimeThemeBoundary/);
  });

  it("uses an un-xfailed managed development browser target", () => {
    expect(reactContextProvider.target).toEqual({
      kind: "browser",
      webAppDir: "examples/sample-fullstack-app",
      webUrl: "http://127.0.0.1:5173/?rdt_scenario=context-provider",
    });
    expect(reactContextProvider.xfailCorrectness).toBeUndefined();
    expect(reactContextProvider.xfailMechanic).toBeUndefined();
  });
});
