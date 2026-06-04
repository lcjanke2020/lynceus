// Unit tests for the trace writer + parser. The writer-shape and
// toolPairs tests use memoryTraceWriter so they stay fast and
// deterministic. The legacy-fold tests in `readTraceFile` need a real
// file on disk; those use a tmp dir via fs.mkdtempSync.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryTraceWriter, readTraceFile, toolPairs } from "./trace.js";
import { sanitizeModelId } from "./runner.js";
import type {
  ScenarioEndEntry,
  ScenarioStartEntry,
  TraceEntry,
  UsageEntry,
} from "./types.js";

describe("trace writer", () => {
  it("auto-populates ts on entries that don't carry one", () => {
    const sink: TraceEntry[] = [];
    const w = memoryTraceWriter(sink);
    w.write({
      t: "tool_call",
      iter: 1,
      toolUseId: "tu_1",
      tool: "set_breakpoint",
      input: {},
    } as unknown as TraceEntry);
    expect(sink).toHaveLength(1);
    expect(sink[0]!.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves caller-supplied ts", () => {
    const sink: TraceEntry[] = [];
    const w = memoryTraceWriter(sink);
    const ts = "2026-05-15T14:00:00.000Z";
    w.write({
      t: "tool_call",
      ts,
      iter: 1,
      toolUseId: "tu_1",
      tool: "navigate",
      input: { url: "http://x" },
    });
    expect(sink[0]!.ts).toBe(ts);
  });
});

describe("toolPairs", () => {
  it("matches calls to results by toolUseId", () => {
    const trace: TraceEntry[] = [
      {
        t: "tool_call",
        ts: "x",
        iter: 1,
        toolUseId: "a",
        tool: "set_breakpoint",
        input: { file: "handlers.ts", line: 12 },
      },
      {
        t: "tool_call",
        ts: "x",
        iter: 1,
        toolUseId: "b",
        tool: "click",
        input: { selector: "#go" },
      },
      {
        t: "tool_result",
        ts: "x",
        iter: 1,
        toolUseId: "a",
        tool: "set_breakpoint",
        isError: false,
        output: { id: "bp_1" },
      },
      {
        t: "tool_result",
        ts: "x",
        iter: 1,
        toolUseId: "b",
        tool: "click",
        isError: true,
        errorCode: "not_found",
        output: { error: "not_found", message: "no such el" },
      },
    ];
    const pairs = toolPairs(trace);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      tool: "set_breakpoint",
      isError: false,
      input: { file: "handlers.ts", line: 12 },
    });
    expect(pairs[1]).toMatchObject({
      tool: "click",
      isError: true,
      errorCode: "not_found",
    });
  });

  it("skips a result without a prior call (resilient to malformed traces)", () => {
    const trace: TraceEntry[] = [
      {
        t: "tool_result",
        ts: "x",
        iter: 1,
        toolUseId: "orphan",
        tool: "navigate",
        isError: false,
        output: {},
      },
    ];
    const pairs = toolPairs(trace);
    // The orphan result is still surfaced (the grader iterates them); input
    // is undefined since there was no matching call.
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.input).toBeUndefined();
  });
});

describe("new-shape UsageEntry round-trip", () => {
  it("writes cacheTokens map through memoryTraceWriter", () => {
    const sink: TraceEntry[] = [];
    const w = memoryTraceWriter(sink);
    const entry: UsageEntry = {
      t: "usage",
      ts: "2026-05-18T00:00:00.000Z",
      iter: 1,
      inputTokens: 500,
      outputTokens: 100,
      cacheTokens: {
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 200,
      },
    };
    w.write(entry);
    expect(sink).toHaveLength(1);
    const got = sink[0] as UsageEntry;
    expect(got.t).toBe("usage");
    expect(got.inputTokens).toBe(500);
    expect(got.outputTokens).toBe(100);
    expect(got.cacheTokens).toEqual({
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
    });
    // Legacy flat fields must not be present on a new-shape write.
    expect(
      (got as UsageEntry & { cacheCreationInputTokens?: number })
        .cacheCreationInputTokens,
    ).toBeUndefined();
    expect(
      (got as UsageEntry & { cacheReadInputTokens?: number })
        .cacheReadInputTokens,
    ).toBeUndefined();
  });
});

describe("readTraceFile legacy-shape fold", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cdp-mcp-trace-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeNdjson(path: string, lines: unknown[]): void {
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("folds legacy usage cache fields into cacheTokens map", () => {
    const p = join(tmp, "compute-step-trial-1.ndjson");
    writeNdjson(p, [
      {
        t: "usage",
        ts: "2026-05-17T00:00:00.000Z",
        iter: 1,
        inputTokens: 500,
        outputTokens: 100,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 75,
      },
      {
        t: "usage",
        ts: "2026-05-17T00:00:01.000Z",
        iter: 2,
        inputTokens: 300,
        outputTokens: 80,
        // Only one of the two legacy fields present — fold should still work.
        cacheReadInputTokens: 999,
      },
    ]);
    const entries = readTraceFile(p);
    expect(entries).toHaveLength(2);

    const u1 = entries[0] as UsageEntry & {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
    expect(u1.cacheTokens).toEqual({
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 75,
    });
    expect(u1.cacheCreationInputTokens).toBeUndefined();
    expect(u1.cacheReadInputTokens).toBeUndefined();

    const u2 = entries[1] as UsageEntry & {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
    expect(u2.cacheTokens).toEqual({ cacheReadInputTokens: 999 });
    expect(u2.cacheReadInputTokens).toBeUndefined();
  });

  it("defaults provider='anthropic' on legacy scenario_start entries", () => {
    const p = join(tmp, "compute-step-trial-1.ndjson");
    writeNdjson(p, [
      {
        t: "scenario_start",
        ts: "2026-05-17T00:00:00.000Z",
        scenario: "compute-step",
        trial: 1,
        model: "claude-opus-4-7",
        reasoning: { level: "medium", budgetTokens: 4096 },
        variantUrl: "http://localhost:12345",
      },
    ]);
    const entries = readTraceFile(p);
    expect(entries).toHaveLength(1);
    const s = entries[0] as ScenarioStartEntry;
    expect(s.t).toBe("scenario_start");
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-opus-4-7");
  });

  it("leaves explicit scenario_start.provider untouched", () => {
    const p = join(tmp, "compute-step-openai-x-trial-1.ndjson");
    writeNdjson(p, [
      {
        t: "scenario_start",
        ts: "2026-05-17T00:00:00.000Z",
        scenario: "compute-step",
        trial: 1,
        provider: "openai",
        model: "gpt-5.5",
        reasoning: { level: "none" },
        variantUrl: "http://localhost:12345",
      },
    ]);
    const entries = readTraceFile(p);
    const s = entries[0] as ScenarioStartEntry;
    expect(s.provider).toBe("openai");
  });

  it("folds legacy scenario_end.totals cache fields", () => {
    const p = join(tmp, "compute-step-trial-1.ndjson");
    writeNdjson(p, [
      {
        t: "scenario_end",
        ts: "2026-05-17T00:00:10.000Z",
        scenario: "compute-step",
        trial: 1,
        finalAnswer: "done",
        oracle: {
          correctness: 1,
          mechanic: 1,
          efficiency: 1,
          recovery: 0,
          notes: "",
        },
        elapsedMs: 10_000,
        totals: {
          iters: 5,
          toolCalls: 4,
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 200,
          cacheReadInputTokens: 800,
          costUsd: 0.42,
        },
      },
    ]);
    const entries = readTraceFile(p);
    expect(entries).toHaveLength(1);
    const e = entries[0] as ScenarioEndEntry & {
      totals: ScenarioEndEntry["totals"] & {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    };
    expect(e.totals.cacheTokens).toEqual({
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 800,
    });
    expect(e.totals.cacheCreationInputTokens).toBeUndefined();
    expect(e.totals.cacheReadInputTokens).toBeUndefined();
  });
});

describe("sanitizeModelId", () => {
  it("leaves safe ids unchanged", () => {
    expect(sanitizeModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("replaces slashes with underscores", () => {
    expect(sanitizeModelId("nvidia/nemotron-3-super")).toBe(
      "nvidia_nemotron-3-super",
    );
    expect(sanitizeModelId("openai/gpt-oss-120b")).toBe("openai_gpt-oss-120b");
  });

  it("replaces multiple unsafe chars (slashes, spaces)", () => {
    expect(sanitizeModelId("a/b/c d")).toBe("a_b_c_d");
  });
});
