// Shared types for the L4 eval harness.
//
// Three layers of data move through the system:
//   1. Scenario definition (this file's `Scenario`) — static input.
//   2. Trace entries (`TraceEntry` here, NDJSON on disk) — one line per
//      meaningful event during a single trial.
//   3. Score (`OracleResult` + per-scenario rollup) — what the grader emits.
//
// Vendor identity lives on `ScenarioStartEntry.provider` (added in #49);
// per-iter `UsageEntry.cacheTokens` carries vendor-tagged cache token
// activity keyed by vendor-native field name (Anthropic populates
// `cacheCreationInputTokens` / `cacheReadInputTokens`, OpenAI populates
// `cachedTokens`, etc.). Pre-#49 traces (with no `provider` field and the
// flat `cacheCreationInputTokens?` / `cacheReadInputTokens?` shape) are
// folded into the new shape on read by `readTraceFile` so downstream
// consumers don't branch on schema version.

import type { Vendor } from "./vendor.js";

/** Discriminated union over the target the scenario drives.
 *
 *  Added when the harness gained a Node-target seam so the same
 *  runner can host both browser scenarios (the original surface) and
 *  Node scenarios (`launch_node`-driven). Approach A (additive
 *  optional `Scenario.target?` field) was chosen over Approach B
 *  (`Scenario = BrowserScenario | NodeScenario`) to avoid touching
 *  all existing browser scenarios — they continue to carry
 *  `variantDir` and the runner's `resolveTarget()` helper folds them
 *  into `{ kind: "browser", variantDistDir: variantDir }`.
 *
 *  - `browser` — drives a sample-app variant served from `variantDistDir`
 *    over a port-0 static server, launches Chrome, frames the first
 *    user message as `Page under test: ${url}`.
 *  - `node`    — drives a built JS entrypoint at `script` via
 *    `launch_node`, skips static-server + Chrome resolution, frames the
 *    first user message as `Node script under test: ${script}`. */
export type ScenarioTarget =
  | { kind: "browser"; variantDistDir: string }
  | { kind: "node"; script: string };

export interface Scenario {
  /** Identifier — matches the filename under evals/scenarios/. */
  name: string;
  /** Sub-directory under evals/sample-app-variants/ to serve as the page
   *  under test. The default is the canonical examples/sample-app for
   *  scenarios that don't need a fork. **Browser scenarios only** — Node
   *  scenarios omit this and supply `target: { kind: "node", script }`
   *  instead. Optional now that the harness supports Node targets; the runner's
   *  `resolveTarget()` helper throws at startup if a scenario has
   *  neither `variantDir` nor `target`. */
  variantDir?: string;
  /** Explicit target discriminator — when set, takes precedence over the
   *  legacy `variantDir` fallback. New Node scenarios set this; existing
   *  browser scenarios leave it unset and rely on `variantDir`. The
   *  runner's `resolveTarget(scenario)` helper resolves the effective
   *  target from these two fields. */
  target?: ScenarioTarget;
  /** The natural-language prompt the agent receives as the first user
   *  message. */
  prompt: string;
  /** Programmatic oracle — receives the full trace + the model's final
   *  text answer; returns a structured verdict. Pure function, no I/O. */
  oracle: (trace: TraceEntry[], finalAnswer: string) => OracleResult;
  /** Lower bound on the number of tool calls a correct run should make.
   *  Used by the efficiency score: `tool_calls / oracleMinimumToolCalls`,
   *  capped at 1.0. */
  oracleMinimumToolCalls: number;
  /** Optional: replaces the runner's default system prompt entirely.
   *  Used by adversarial-out-of-order to deliberately omit the standard
   *  "set_breakpoint then wait_for_pause then click" workflow guidance,
   *  so the scenario can test the agent's recovery from a wrong-order
   *  approach. If unset, the runner uses its default. */
  systemPromptOverride?: string;
  /** Optional: this scenario's correctness axis is *expected* to fail.
   *  When true, the rollup reports XFAIL (median correctness=0) or
   *  XPASS (median correctness=1) instead of FAIL / PASS, and neither
   *  causes the CLI to exit nonzero. Mechanic, efficiency, and recovery
   *  axes still score normally. Used by adversarial-out-of-order, where
   *  the deliberately-degraded system prompt makes the correctness=0
   *  outcome design intent rather than a regression. Field name leaves
   *  room for a future `xfailMechanic` without renaming. */
  xfailCorrectness?: boolean;
}

export type TraceEntry =
  | ScenarioStartEntry
  | AssistantMsgEntry
  | ToolCallEntry
  | ToolResultEntry
  | UsageEntry
  | AdapterRetryEntry
  | ScenarioEndEntry;

export interface ScenarioStartEntry {
  t: "scenario_start";
  ts: string; // ISO 8601 UTC
  scenario: string;
  trial: number;
  /** Backend vendor that served this trial. Added in #49 for cross-vendor
   *  eval runs. Pre-#49 traces parsed by `readTraceFile` get this field
   *  defaulted to `"anthropic"` (the only vendor before the migration). */
  provider: Vendor;
  model: string;
  reasoning: ReasoningConfig;
  /** For adaptive-thinking models (Opus 4.7+), the resolved Anthropic
   *  `effort` value sent on the request — `low`/`medium`/`high`/`xhigh`/
   *  `max`. Distinct from `reasoning.level` because the harness's tier
   *  vocabulary may translate to a different effort tier (e.g. on models
   *  that don't support `xhigh`, the harness clamps down). Omitted on
   *  budget-style models, where `reasoning.budgetTokens` is the truth. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Public commit SHA the eval was run against, when available. */
  sha?: string;
  /** URL the sample-app variant was served at (for log correlation).
   *  **Optional** — present only on browser trials; Node trials omit
   *  it (there is no static server). Legacy (pre-Node-seam) traces
   *  always carried this field; `normalizeLegacyEntry` in trace.ts
   *  synthesizes a `target` for those by defaulting the entry to
   *  `{ kind: "browser", variantDistDir: "" }`, so downstream consumers
   *  can branch on `target.kind` uniformly. */
  variantUrl?: string;
  /** Target discriminator for this trial — required on entries written by
   *  current runners. Legacy traces are folded to a default
   *  browser kind by `normalizeLegacyEntry` so `target` is always
   *  populated by the time the grader / analytics layer reads it. */
  target: ScenarioTarget;
}

export interface AssistantMsgEntry {
  t: "assistant_msg";
  ts: string;
  iter: number;
  text: string; // concatenated text blocks; empty if only tool_use
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string;
}

export interface ToolCallEntry {
  t: "tool_call";
  ts: string;
  iter: number;
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface ToolResultEntry {
  t: "tool_result";
  ts: string;
  iter: number;
  toolUseId: string;
  tool: string;
  isError: boolean;
  /** Parsed-out error code from the cdp-mcp error envelope (when isError),
   *  or undefined for success / unparseable errors. */
  errorCode?: string;
  output: unknown;
}

/** Sidecar entry — one line per iter that produced thinking blocks.
 *
 *  Written to `<scenario>-<vendor>-<sanitized-model>-trial-<N>.thinking.ndjson`
 *  alongside the main trace, joined on `iter`. Kept in a separate file (not in the main
 *  TraceEntry union) so the main trace stays compact and grep-friendly
 *  while signatures + thinking text live in an opt-in side stream.
 *
 *  The sidecar is sparse — only iters where the model produced thinking
 *  get an entry. Consumers must tolerate "no row for this iter".
 *
 *  Two block shapes:
 *  - `thinking` — visible chain-of-thought + an opaque server-side
 *    `signature` (required for thinking-block round-trip on subsequent
 *    turns).
 *  - `redacted_thinking` — encrypted server-side payload (`data`); the
 *    runner doesn't surface contents but persists the block so the
 *    transcript is reproducible. */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface ThinkingEntry {
  t: "thinking";
  ts: string;
  iter: number;
  blocks: ThinkingBlock[];
}

/** Emitted once per RETRIED adapter call attempt (NOT on the final
 *  successful attempt). Added in #63 so a transient network blip
 *  (TypeError fetch failed, ECONNRESET, 5xx) that the harness now
 *  recovers from is still visible in the per-trial cost story. `attempt`
 *  is 1-indexed and matches the attempt that just FAILED; `backoffMs`
 *  is the realized jittered sleep before the next attempt. Absent in
 *  pre-#63 traces — reader code that does an exhaustive switch on `t`
 *  must include this variant. */
export interface AdapterRetryEntry {
  t: "adapter_retry";
  ts: string;
  iter: number;
  attempt: number;
  error: string;
  backoffMs: number;
}

export interface UsageEntry {
  t: "usage";
  ts: string;
  iter: number;
  inputTokens: number;
  outputTokens: number;
  /** Vendor-specific cache token counts, keyed by vendor-native field
   *  name. Anthropic populates {cacheCreationInputTokens,
   *  cacheReadInputTokens}. OpenAI populates {cachedTokens} from
   *  usage.prompt_tokens_details.cached_tokens. Vertex populates its
   *  own {cachedContentTokens} from the cachedContents API. LM Studio
   *  leaves it empty/undefined. The pricing layer reads the appropriate
   *  sub-key for the vendor when computing cost. Omitted on disk when
   *  the map would be empty. */
  cacheTokens?: Record<string, number>;
}

export interface ScenarioEndEntry {
  t: "scenario_end";
  ts: string;
  scenario: string;
  trial: number;
  finalAnswer: string;
  oracle: OracleResult;
  elapsedMs: number;
  totals: {
    iters: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** Per-trial sum of vendor-tagged cache token activity. Same key
     *  convention as `UsageEntry.cacheTokens`. Always present (possibly
     *  empty for vendors that don't report cache token counts). */
    cacheTokens: Record<string, number>;
    /** Estimated cost in USD using the pricing in evals/harness/model.ts. */
    costUsd: number;
  };
}

export interface OracleResult {
  /** Did the agent identify the bug correctly? Typically a pattern match
   *  over `finalAnswer` (file:line + bug description). Independent of
   *  HOW the agent got there. */
  correctness: 0 | 1;
  /** Did the agent exercise the debugger workflow the scenario is built
   *  to test? Per-scenario gate on the relevant tool-call shape — e.g.
   *  `set_breakpoint` + observed pause for compute-step, conditional-bp
   *  setup OR ≥3 clicks for conditional-bp, multi-session pause for
   *  worker-bug. This is the "MCP under test" axis — a model that
   *  source-reads its way to a correct answer scores correctness=1 but
   *  mechanic=0. PR #12 rotation analytics depends on this split. */
  mechanic: 0 | 1;
  /** Efficiency ratio. < 1 means the agent took more tool calls than the
   *  oracle minimum (capped at 1 — extra-fast runs don't get credit because
   *  the oracle floor isn't tight enough to reward sub-minimum). */
  efficiency: number;
  /** Number of distinct error codes the agent recovered from (the next
   *  tool call differed from the failing one). Diagnostic only. */
  recovery: number;
  /** Free-text breadcrumb for debugging — what the oracle saw and why
   *  it passed/failed. Surface in the per-night summary. */
  notes: string;
}

export interface ReasoningConfig {
  /** Tier label for the run's reasoning configuration.
   *
   *  - `none` — extended thinking disabled.
   *  - `low` / `medium` / `high` / `xhigh` / `max` — first-class tier
   *    vocabulary the planned model rotation will switch
   *    on. Each tier has a default budget defined in model.ts; an
   *    explicit `EVAL_REASONING_BUDGET` env override is allowed.
   *  - `custom` — reserved for the env-driven path when ONLY a budget
   *    is provided (no tier name). Out-of-band from the tier
   *    vocabulary so analytics over traces can filter it cleanly. */
  level: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "custom";
  budgetTokens?: number;
}

/** A "trial" is one (scenario, model, reasoning) run. The aggregate
 *  pass/fail per scenario is the median of multiple trials. */
export interface TrialOutcome {
  scenario: string;
  trial: number;
  oracle: OracleResult;
  elapsedMs: number;
  costUsd: number;
  tracePath: string;
}
