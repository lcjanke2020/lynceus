// NDJSON trace writer + parser.
//
// One file per (scenario, trial) under
// evals/runs/<run-id>/<scenario>-<vendor>-<sanitized-model>-trial-<N>.ndjson.
// Each line is a single TraceEntry. Append-only; readers parse line-by-
// line. The schema is captured in types.ts — every entry has a `t`
// discriminator + an ISO-8601 `ts`. Pre-#49 traces named
// `<scenario>-trial-<N>.ndjson` (no vendor/model in the filename, no
// `provider` on scenario_start, flat cache fields on usage) remain
// readable — `normalizeLegacyEntry` folds them into the new shape.
//
// Why NDJSON over JSON-array: the harness can crash mid-trial (network
// blip, model 410, vitest worker death). An NDJSON file is still
// parseable up to the last newline; a half-written JSON array isn't.
// Plus tail -f is much more useful while a trial runs.

import { mkdirSync, createWriteStream, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import type {
  ScenarioEndEntry,
  ScenarioStartEntry,
  TraceEntry,
  UsageEntry,
} from "./types.js";

/** Anything with an optional `ts` field can flow through the writer — it
 *  just JSON-serializes. Default to TraceEntry for existing call sites;
 *  sidecar writers (e.g., thinking blocks) parameterize T. */
type WritableEntry = { ts?: string };

export interface TraceWriter<T extends WritableEntry = TraceEntry> {
  write(entry: T): void;
  /** Close the underlying stream. Must be awaited if writes overlap with
   *  process exit. */
  close(): Promise<void>;
}

export function openTraceWriter<T extends WritableEntry = TraceEntry>(
  filePath: string,
): TraceWriter<T> {
  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  return {
    write(entry: T): void {
      // ts is auto-populated here so every emitter doesn't have to remember.
      const withTs = entry.ts ? entry : { ...entry, ts: isoNowUtc() };
      stream.write(JSON.stringify(withTs) + "\n");
    },
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Fold legacy (pre-#49) trace entries into the new shape so downstream
 *  code never has to branch on schema version. Mutates and returns the
 *  input.
 *
 *  Three legacy shapes get folded:
 *  - `scenario_start` without `provider` — defaults to `"anthropic"`
 *    (the only vendor before the migration).
 *  - `usage` with flat `cacheCreationInputTokens?` / `cacheReadInputTokens?`
 *    — moved into `cacheTokens` map under the same keys.
 *  - `scenario_end.totals` with flat cache fields — same fold as `usage`.
 *
 *  Existing traces in `evals/runs/` predating #49 need to read back as
 *  if they were in the new shape; this keeps the grader and analytics
 *  layer schema-agnostic. */
function normalizeLegacyEntry(entry: TraceEntry): TraceEntry {
  if (entry.t === "scenario_start") {
    const e = entry as ScenarioStartEntry;
    if (e.provider === undefined) {
      e.provider = "anthropic";
    }
  } else if (entry.t === "usage") {
    const e = entry as UsageEntry & {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
    if (
      e.cacheTokens === undefined &&
      (e.cacheCreationInputTokens !== undefined ||
        e.cacheReadInputTokens !== undefined)
    ) {
      e.cacheTokens = {};
      if (e.cacheCreationInputTokens !== undefined) {
        e.cacheTokens.cacheCreationInputTokens = e.cacheCreationInputTokens;
      }
      if (e.cacheReadInputTokens !== undefined) {
        e.cacheTokens.cacheReadInputTokens = e.cacheReadInputTokens;
      }
      delete e.cacheCreationInputTokens;
      delete e.cacheReadInputTokens;
    }
  } else if (entry.t === "scenario_end") {
    const e = entry as ScenarioEndEntry & {
      totals: ScenarioEndEntry["totals"] & {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    };
    const t = e.totals;
    if (t.cacheTokens === undefined) {
      t.cacheTokens = {};
      if (t.cacheCreationInputTokens !== undefined) {
        t.cacheTokens.cacheCreationInputTokens = t.cacheCreationInputTokens;
      }
      if (t.cacheReadInputTokens !== undefined) {
        t.cacheTokens.cacheReadInputTokens = t.cacheReadInputTokens;
      }
      delete t.cacheCreationInputTokens;
      delete t.cacheReadInputTokens;
    }
  }
  return entry;
}

/** Synchronous full-file read, for the grader / aggregator. */
export function readTraceFile(filePath: string): TraceEntry[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const out: TraceEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(normalizeLegacyEntry(JSON.parse(line) as TraceEntry));
    } catch {
      // skip malformed lines — better to lose one entry than the whole file
    }
  }
  return out;
}

/** In-memory writer for tests — no filesystem I/O, accumulates into an
 *  array the test can inspect. */
export function memoryTraceWriter<T extends WritableEntry = TraceEntry>(
  sink: T[],
): TraceWriter<T> {
  return {
    write(entry: T): void {
      const withTs = entry.ts ? entry : ({ ...entry, ts: isoNowUtc() } as T);
      sink.push(withTs);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function isoNowUtc(): string {
  return new Date().toISOString();
}

/** Convenience: pull every tool_call/tool_result pair out of a trace. */
export function toolPairs(trace: TraceEntry[]): Array<{
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  errorCode?: string;
}> {
  const calls = new Map<
    string,
    { tool: string; input: unknown }
  >();
  const pairs: Array<{ tool: string; input: unknown; output: unknown; isError: boolean; errorCode?: string }> = [];
  for (const entry of trace) {
    if (entry.t === "tool_call") {
      calls.set(entry.toolUseId, { tool: entry.tool, input: entry.input });
    } else if (entry.t === "tool_result") {
      const call = calls.get(entry.toolUseId);
      pairs.push({
        tool: entry.tool,
        input: call?.input,
        output: entry.output,
        isError: entry.isError,
        ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
      });
    }
  }
  return pairs;
}

// Re-export for test ergonomics — callers don't need to know about Writable.
export type { Writable };
