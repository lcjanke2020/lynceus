// L3 e2e — drive `runTrial` end-to-end against a Node target with a stub
// VendorAdapter. Verifies the Node-target seam wiring at the integration
// tier: the runner spawns a real cdp-mcp subprocess, the subprocess hosts
// a real `launch_node` against examples/sample-node-app/dist/index.js, the
// scripted agent issues real MCP tool calls through it, and the runner
// writes a trace whose `scenario_start.target.kind === "node"` and that
// has no `variantUrl` field.
//
// What this does NOT cover:
//   - The LLM tool-use loop dynamics (that's L4 and costs paid API time).
//   - Oracle scoring beyond the trivial "all-good" result the stub returns.
//   - Browser-target parity — the existing 8 scenarios cover that already.

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrial, type BudgetTracker } from "../../evals/harness/runner.js";
import { readTraceFile } from "../../evals/harness/trace.js";
import type {
  OracleResult,
  Scenario,
  ScenarioStartEntry,
  TraceEntry,
} from "../../evals/harness/types.js";
import type {
  NormalizedMessage,
  VendorAdapter,
  VendorMessageRequest,
} from "../../evals/harness/vendor.js";

const FIXTURE_SCRIPT = join(
  process.cwd(),
  "examples",
  "sample-node-app",
  "dist",
  "index.js",
);
const SERVER_PATH = join(process.cwd(), "dist", "index.js");

/** Build a stub VendorAdapter that scripts a fixed 3-turn conversation:
 *    turn 1: call launch_node({ script })
 *    turn 2: call wait_for_pause()
 *    turn 3: end_turn with a final answer
 *
 *  The trial stays $0 because `vendor: "lm-studio"` routes pricingFor()
 *  to the free wildcard row — NOT because token counts are zero. The
 *  stubbed `usage` fields below are deliberately non-zero (10/5, 12/6,
 *  14/8) so the BudgetTracker still exercises its accumulator path on
 *  every iter; estimateCostUsd() with the lm-studio sentinel pricing
 *  evaluates to 0, so spentUsd ends at 0 despite real token math. */
function makeStubAdapter(script: string): VendorAdapter {
  let turn = 0;
  return {
    vendor: "lm-studio",
    model: "stub-test-model",
    async messages(_req: VendorMessageRequest): Promise<NormalizedMessage> {
      turn += 1;
      if (turn === 1) {
        return {
          id: "msg_stub_1",
          content: [
            { type: "text", text: "" },
            {
              type: "tool_use",
              id: "tu_stub_launch",
              name: "launch_node",
              input: { script },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      if (turn === 2) {
        return {
          id: "msg_stub_2",
          content: [
            {
              type: "tool_use",
              id: "tu_stub_wait",
              name: "wait_for_pause",
              input: { timeout_ms: 10_000 },
            },
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 12, outputTokens: 6 },
        };
      }
      // Terminal turn — stub final answer, end_turn.
      return {
        id: "msg_stub_3",
        content: [
          {
            type: "text",
            text: "Done — launched Node and observed the entry pause.",
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 14, outputTokens: 8 },
      };
    },
  };
}

/** Trivial all-pass oracle — exercises the grader plumbing without
 *  asserting on specific tool-call shapes. */
function stubOracle(): OracleResult {
  return {
    correctness: 1,
    mechanic: 1,
    efficiency: 1,
    recovery: 0,
    notes: "stub-oracle: trivially-passing for runner integration test",
  };
}

function makeNodeScenario(): Scenario {
  return {
    name: "eval-runner-node-e2e-stub",
    target: { kind: "node", script: FIXTURE_SCRIPT },
    prompt:
      "Stub prompt for the runner integration test. Drive the Node Inspector against the fixture script and report what you observed.",
    oracle: stubOracle,
    oracleMinimumToolCalls: 2,
  };
}

describe("eval runner — Node target (e2e)", () => {
  const tmpOutDir = mkdtempSync(join(tmpdir(), "cdp-mcp-eval-runner-node-"));

  afterAll(() => {
    rmSync(tmpOutDir, { recursive: true, force: true });
  });

  it("drives runTrial against a Node scenario with no static server, no Chrome", async () => {
    expect(existsSync(FIXTURE_SCRIPT)).toBe(true);
    expect(existsSync(SERVER_PATH)).toBe(true);

    const scenario = makeNodeScenario();
    const adapter = makeStubAdapter(FIXTURE_SCRIPT);
    const budget: BudgetTracker = { spentUsd: 0, ceilingUsd: 100 };

    const outcome = await runTrial({
      scenario,
      trial: 1,
      outDir: tmpOutDir,
      budget,
      target: { kind: "node", script: FIXTURE_SCRIPT },
      serverPath: SERVER_PATH,
      adapter,
    });

    expect(outcome.scenario).toBe(scenario.name);
    expect(outcome.trial).toBe(1);
    expect(outcome.tracePath).toMatch(/eval-runner-node-e2e-stub-lm-studio-stub-test-model-trial-1\.ndjson$/);

    const trace = readTraceFile(outcome.tracePath);
    expect(trace.length).toBeGreaterThan(0);

    // scenario_start MUST carry target.kind === "node" and MUST NOT carry
    // variantUrl (the Node branch never starts a static server).
    const startEntry = trace.find(
      (e: TraceEntry) => e.t === "scenario_start",
    ) as ScenarioStartEntry | undefined;
    expect(startEntry).toBeDefined();
    expect(startEntry!.target).toEqual({ kind: "node", script: FIXTURE_SCRIPT });
    expect(startEntry!.variantUrl).toBeUndefined();
    expect(startEntry!.provider).toBe("lm-studio");
    expect(startEntry!.model).toBe("stub-test-model");

    // The agent actually called launch_node and wait_for_pause via the
    // real MCP subprocess — both tool_result entries must be in the
    // trace and neither marked as an error (the subprocess wired
    // launch_node and wait_for_pause, and the fixture script paused at
    // entry on launch).
    const toolResults = trace.filter((e) => e.t === "tool_result") as Array<{
      tool: string;
      isError: boolean;
      output: unknown;
    }>;
    const launchResult = toolResults.find((r) => r.tool === "launch_node");
    const waitResult = toolResults.find((r) => r.tool === "wait_for_pause");
    expect(launchResult).toBeDefined();
    expect(launchResult!.isError).toBe(false);
    expect(waitResult).toBeDefined();
    expect(waitResult!.isError).toBe(false);

    // The trial completed cleanly — scenario_end must be present.
    const endEntry = trace.find((e) => e.t === "scenario_end");
    expect(endEntry).toBeDefined();
  });
});
