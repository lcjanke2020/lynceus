// Unit tests for the runner's Node-target seam.
//
// All synthetic — no real MCP spawn, no real LLM, no real Node child.
// The runner's `runTrial` itself is end-to-end-tested in
// test/e2e/eval-runner-node.e2e.test.ts (L3); this file pins the
// module-level invariants the L4 trial flow depends on:
//   - `resolveTarget()` correctly folds Approach-A optional `target?` +
//     legacy `variantDir` into the discriminated union, and throws on
//     misconfig.
//   - `BROWSER_ONLY_TOOLS` is derived from `TOOL_KIND_SUPPORT` at module
//     load — sentinel against future capability-map regressions where
//     a tool's kind set silently widens.
//   - `NODE_SYSTEM_PROMPT` actually lists the blocked browser-only tools
//     (so the agent doesn't waste first-turn planning on probes that
//     return `unsupported_target`).
//   - `buildScenarioStartEntry` includes `variantUrl` only on browser
//     trials and `target` on every entry — the conditional-shape
//     branching is otherwise hard to test without spinning up the
//     trial machinery.

import { describe, it, expect } from "vitest";
import {
  resolveTarget,
  buildScenarioStartEntry,
  BROWSER_ONLY_TOOLS,
  NODE_SYSTEM_PROMPT,
} from "./runner.js";
import type {
  OracleResult,
  Scenario,
  ScenarioStartEntry,
} from "./types.js";
import type { VendorAdapter } from "./vendor.js";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: "test-scenario",
    variantDir: "examples/sample-app/dist",
    prompt: "prompt",
    oracle: (): OracleResult => ({
      correctness: 1,
      mechanic: 1,
      efficiency: 0,
      recovery: 0,
      notes: "",
    }),
    oracleMinimumToolCalls: 4,
    ...overrides,
  };
}

function stubAdapter(): VendorAdapter {
  return {
    vendor: "anthropic",
    model: "claude-test",
    messages: async () => {
      throw new Error("stubAdapter.messages should not be called in unit tests");
    },
  };
}

describe("resolveTarget (additive target discriminator)", () => {
  it("folds legacy variantDir into a browser target when target unset", () => {
    const s = scenario({ variantDir: "examples/sample-app/dist", target: undefined });
    expect(resolveTarget(s)).toEqual({
      kind: "browser",
      variantDistDir: "examples/sample-app/dist",
    });
  });

  it("returns explicit browser target when set", () => {
    const s = scenario({
      variantDir: undefined,
      target: { kind: "browser", variantDistDir: "evals/sample-app-variants/x/dist" },
    });
    expect(resolveTarget(s)).toEqual({
      kind: "browser",
      variantDistDir: "evals/sample-app-variants/x/dist",
    });
  });

  it("returns explicit node target when set", () => {
    const s = scenario({
      variantDir: undefined,
      target: { kind: "node", script: "examples/sample-node-app/dist/index.js" },
    });
    expect(resolveTarget(s)).toEqual({
      kind: "node",
      script: "examples/sample-node-app/dist/index.js",
    });
  });

  it("prefers explicit target over legacy variantDir when both are set", () => {
    // Approach A invariant — `target` wins. variantDir is meaningless on
    // Node scenarios, so this is the path Node scenarios actually use if
    // someone copy-pastes from a browser scenario template.
    const s = scenario({
      variantDir: "ignored/path",
      target: { kind: "node", script: "/abs/script.js" },
    });
    expect(resolveTarget(s)).toEqual({ kind: "node", script: "/abs/script.js" });
  });

  it("throws when neither variantDir nor target is set", () => {
    const s = scenario({ variantDir: undefined, target: undefined });
    expect(() => resolveTarget(s)).toThrow(/has neither 'target' nor 'variantDir'/);
  });
});

describe("BROWSER_ONLY_TOOLS (derived from TOOL_KIND_SUPPORT)", () => {
  it("includes the canonical browser-only surface", () => {
    // Sentinel — if any of these silently regress to permissive in
    // src/session/capabilities.ts, the NODE_SYSTEM_PROMPT would stop
    // listing them and the agent would waste tool calls on probes.
    for (const expected of [
      "navigate",
      "reload",
      "click",
      "type_text",
      "press_key",
      "screenshot",
      "get_network_requests",
      "get_request_body",
      "get_response_body",
      "select_target",
    ]) {
      expect(BROWSER_ONLY_TOOLS).toContain(expected);
    }
  });

  it("excludes kind-agnostic tools that work on both browser and node", () => {
    // Sanity — Runtime-domain tools (evaluate, get_scope, etc.) and
    // Debugger-domain tools (set_breakpoint, resume, wait_for_pause)
    // should NEVER be in the browser-only list because Node sessions
    // need them too.
    for (const notExpected of [
      "evaluate",
      "set_breakpoint",
      "resume",
      "wait_for_pause",
      "get_call_stack",
      "get_scope",
      "get_script_source",
      "list_scripts",
      "get_console_logs",
      "close_session",
    ]) {
      expect(BROWSER_ONLY_TOOLS).not.toContain(notExpected);
    }
  });

  it("excludes node-only tools", () => {
    // get_node_output is NODE_ONLY — should not be in the browser-only
    // list (the Node prompt lists it as available, not blocked).
    expect(BROWSER_ONLY_TOOLS).not.toContain("get_node_output");
  });

  it("is sorted (deterministic prompt bytes for cache_control)", () => {
    // A non-deterministic prompt would defeat the cache_control marker
    // on the system block — see runner.ts header §Cache control.
    const sorted = [...BROWSER_ONLY_TOOLS].sort();
    expect(BROWSER_ONLY_TOOLS).toEqual(sorted);
  });
});

describe("NODE_SYSTEM_PROMPT", () => {
  it("describes the Node-specific test plan with launch_node", () => {
    expect(NODE_SYSTEM_PROMPT).toMatch(/launch_node/);
    expect(NODE_SYSTEM_PROMPT).toMatch(/wait_for_pause/);
    expect(NODE_SYSTEM_PROMPT).toMatch(/set_breakpoint/);
    expect(NODE_SYSTEM_PROMPT).toMatch(/get_call_stack/);
  });

  it("warns the agent against reason-equality on Node pauses", () => {
    // V8 emits non-standard reason strings on Node pauses, so the
    // prompt should steer the agent to drive off hit_breakpoint_ids
    // instead.
    expect(NODE_SYSTEM_PROMPT).toMatch(/hit_breakpoint_ids/);
  });

  it("mentions the raw-stdio output buffer alongside console_logs", () => {
    expect(NODE_SYSTEM_PROMPT).toMatch(/get_node_output/);
    expect(NODE_SYSTEM_PROMPT).toMatch(/get_console_logs/);
  });

  it("includes the BROWSER_ONLY_TOOLS list explicitly", () => {
    // Spot-check that at least three of the derived blocked tools are
    // listed in the prompt body — the runtime-derivation should put the
    // full sorted list into the prompt at module load.
    let listed = 0;
    for (const tool of BROWSER_ONLY_TOOLS) {
      if (NODE_SYSTEM_PROMPT.includes(`  - ${tool}`)) listed += 1;
    }
    expect(listed).toBe(BROWSER_ONLY_TOOLS.length);
    expect(BROWSER_ONLY_TOOLS.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT mention Chrome-specific browser tools as available", () => {
    // navigate/click/screenshot live under the BLOCKED list, not in
    // the test plan steps. A loose regex catches "navigate to" or
    // "click the button" type instructions that would mislead the agent.
    // We check by ensuring `navigate` only appears in the blocked-list
    // section (i.e. preceded by the `NOT available` header).
    const idx = NODE_SYSTEM_PROMPT.indexOf("NOT available in a Node session");
    expect(idx).toBeGreaterThan(0);
    const planSection = NODE_SYSTEM_PROMPT.slice(0, idx);
    // Allow "navigate" only outside the test plan section. The plan
    // section MUST NOT have a "navigate to ..." instruction.
    expect(planSection).not.toMatch(/navigate to/i);
    expect(planSection).not.toMatch(/click /i);
  });
});

describe("buildScenarioStartEntry (trace-shape factor-out)", () => {
  it("includes variantUrl on browser trials", () => {
    const entry: ScenarioStartEntry = buildScenarioStartEntry({
      scenario: scenario({ name: "compute-step" }),
      trial: 1,
      adapter: stubAdapter(),
      target: { kind: "browser", variantDistDir: "examples/sample-app/dist" },
      reasoning: { level: "none" },
      variantUrl: "http://127.0.0.1:12345",
    });
    expect(entry.t).toBe("scenario_start");
    expect(entry.scenario).toBe("compute-step");
    expect(entry.trial).toBe(1);
    expect(entry.provider).toBe("anthropic");
    expect(entry.model).toBe("claude-test");
    expect(entry.variantUrl).toBe("http://127.0.0.1:12345");
    expect(entry.target).toEqual({
      kind: "browser",
      variantDistDir: "examples/sample-app/dist",
    });
  });

  it("omits variantUrl on Node trials", () => {
    const entry = buildScenarioStartEntry({
      scenario: scenario({
        name: "node-compute-step",
        variantDir: undefined,
        target: { kind: "node", script: "/dist/index.js" },
      }),
      trial: 2,
      adapter: stubAdapter(),
      target: { kind: "node", script: "/dist/index.js" },
      reasoning: { level: "medium", budgetTokens: 4096 },
    });
    expect(entry.variantUrl).toBeUndefined();
    expect(entry.target).toEqual({ kind: "node", script: "/dist/index.js" });
    expect(entry.reasoning).toEqual({ level: "medium", budgetTokens: 4096 });
  });

  it("includes resolvedEffort when provided (adaptive thinking)", () => {
    const entry = buildScenarioStartEntry({
      scenario: scenario(),
      trial: 1,
      adapter: stubAdapter(),
      target: { kind: "browser", variantDistDir: "x" },
      reasoning: { level: "medium", budgetTokens: 8192 },
      resolvedEffort: "medium",
      variantUrl: "http://x",
    });
    expect(entry.effort).toBe("medium");
  });

  it("omits effort when undefined (budget-style or no-thinking runs)", () => {
    const entry = buildScenarioStartEntry({
      scenario: scenario(),
      trial: 1,
      adapter: stubAdapter(),
      target: { kind: "browser", variantDistDir: "x" },
      reasoning: { level: "none" },
      variantUrl: "http://x",
    });
    expect(entry.effort).toBeUndefined();
  });
});
