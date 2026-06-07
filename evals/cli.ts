#!/usr/bin/env -S npx tsx
// L4 eval CLI — `npx tsx evals/cli.ts --scenarios=compute-step --trials=3`.
//
// Iterates `(scenario, trial)` pairs serially, writes NDJSON traces to
// evals/runs/<run-id>/, prints a scoreboard at the end. Exits 0 if all
// scenarios pass the median-correctness gate, 1 otherwise.
//
// Serial execution is deliberate (plan rev 4 Opus N-7): the Anthropic
// prompt cache is per-request-prefix per-API-key; parallel runners on
// cold caches each pay full input price the first time, blowing the
// cache-hit assumption that the cost-table relies on.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runTrial, BudgetExceeded, type BudgetTracker } from "./harness/runner.js";
import { rollupScenario, renderScoreboard } from "./harness/grader.js";
import { lookupScenario, SCENARIOS } from "./scenarios/index.js";
import {
  readBudgetUsd,
  MODEL_ID,
  REASONING,
  SUPPORTED_MODELS,
} from "./harness/model.js";
import type { TrialOutcome } from "./harness/types.js";
import type { VendorAdapter } from "./harness/vendor.js";
// INVESTIGATION ARTIFACT (issue #45) — not for merge to master. See
// header of evals/harness/lm-studio-adapter.ts for full context.
import { makeLmStudioAdapter } from "./harness/lm-studio-adapter.js";
import { makeOpenaiAdapter } from "./harness/openai-adapter.js";
import { makeOpenaiResponsesAdapter } from "./harness/openai-responses-adapter.js";
import { makeVertexAdapter } from "./harness/vertex-adapter.js";
import { makeDeepseekAdapter } from "./harness/deepseek-adapter.js";
import { makeMoonshotAdapter } from "./harness/moonshot-adapter.js";

function resolveProviderClient(): VendorAdapter | undefined {
  const provider = process.env.EVAL_PROVIDER;
  if (!provider || provider === "anthropic") return undefined; // runner default
  if (provider === "lm-studio") {
    if (!process.env.EVAL_LM_STUDIO_MODEL) {
      throw new Error(
        "EVAL_LM_STUDIO_MODEL is required when EVAL_PROVIDER=lm-studio.",
      );
    }
    return makeLmStudioAdapter();
  }
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when EVAL_PROVIDER=openai.");
    }
    if (!process.env.EVAL_OPENAI_MODEL) {
      throw new Error(
        "EVAL_OPENAI_MODEL is required when EVAL_PROVIDER=openai (e.g. 'gpt-5.5').",
      );
    }
    // Auto-route between the two OpenAI sibling adapters (#58).
    // Reasoning-off → Chat Completions (#50 path); reasoning-on →
    // Responses (#58 path). The gate was originally a fail-closed
    // throw in #50 because the only safe Chat Completions path is
    // reasoning-off (GPT-5.5 returns 400 on tools × reasoning_effort);
    // #58 lifts that gate by adding the Responses path.
    if (REASONING.level !== "none") {
      return makeOpenaiResponsesAdapter();
    }
    return makeOpenaiAdapter();
  }
  if (provider === "vertex") {
    if (!process.env.EVAL_VERTEX_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT) {
      throw new Error(
        "EVAL_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is required when EVAL_PROVIDER=vertex.",
      );
    }
    return makeVertexAdapter();
  }
  if (provider === "deepseek") {
    if (!process.env.EVAL_DEEPSEEK_API_KEY) {
      throw new Error(
        "EVAL_DEEPSEEK_API_KEY is required when EVAL_PROVIDER=deepseek.",
      );
    }
    if (!process.env.EVAL_DEEPSEEK_MODEL) {
      throw new Error(
        "EVAL_DEEPSEEK_MODEL is required when EVAL_PROVIDER=deepseek (e.g. 'deepseek-v4-pro').",
      );
    }
    return makeDeepseekAdapter();
  }
  if (provider === "moonshot") {
    if (!process.env.EVAL_MOONSHOT_API_KEY) {
      throw new Error(
        "EVAL_MOONSHOT_API_KEY is required when EVAL_PROVIDER=moonshot.",
      );
    }
    if (!process.env.EVAL_MOONSHOT_MODEL) {
      throw new Error(
        "EVAL_MOONSHOT_MODEL is required when EVAL_PROVIDER=moonshot (e.g. 'kimi-k2.6').",
      );
    }
    return makeMoonshotAdapter();
  }
  throw new Error(
    `Unknown EVAL_PROVIDER: '${provider}'. Supported: 'anthropic' (default), 'openai' (#50/#58), 'vertex' (#51), 'deepseek' (LEO-233), 'moonshot' (LEO-233), 'lm-studio' (investigation artifact, issue #45).`,
  );
}

interface ParsedArgs {
  scenarios: string[];
  trials: number;
  runId: string;
  budgetUsd: number;
  outRoot: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    scenarios: Object.keys(SCENARIOS),
    trials: 3,
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    budgetUsd: readBudgetUsd(),
    outRoot: "evals/runs",
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--scenarios=")) {
      out.scenarios = a.split("=")[1]!.split(",").filter(Boolean);
    } else if (a.startsWith("--trials=")) {
      const n = Number(a.split("=")[1]);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--trials must be a positive integer, got '${a}'`);
      }
      out.trials = n;
    } else if (a.startsWith("--run-id=")) {
      out.runId = a.split("=")[1]!;
    } else if (a.startsWith("--out=")) {
      out.outRoot = a.split("=")[1]!;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(
        `Unknown arg '${a}'. Try --help. Known scenarios: ${Object.keys(SCENARIOS).join(", ")}`,
      );
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`L4 eval CLI

Usage:
  npx tsx evals/cli.ts [--scenarios=a,b,c] [--trials=N] [--run-id=ID] [--out=DIR]

Defaults:
  --scenarios: all registered scenarios (${Object.keys(SCENARIOS).join(", ")})
  --trials:    3
  --run-id:    UTC timestamp
  --out:       evals/runs

Env:
  ANTHROPIC_API_KEY       required.
  EVAL_BUDGET_USD         override the default $100 hard cap.
  EVAL_MODEL_OVERRIDE     swap the pinned model. One of:
                          ${SUPPORTED_MODELS.map((m) => `'${m}'`).join(", ")}.
                          Unset uses the default (Opus 4.7 with adaptive
                          medium-effort thinking). Pricing is resolved
                          via PRICING_CATALOG[vendor][model] through
                          pricingFor() so cost estimates stay correct
                          on the swap. To run cheap ad-hoc nightlies
                          on Sonnet 4.6 instead, set
                          EVAL_MODEL_OVERRIDE=claude-sonnet-4-6 (budget-
                          style; thinking off by default — opt in via
                          EVAL_REASONING_LEVEL).
  EVAL_REASONING_LEVEL    one of 'none', 'low', 'medium', 'high', 'xhigh',
                          'max'. On budget-style models (Sonnet 4.6) each
                          tier picks a default budget from TIER_BUDGET_TOKENS.
                          On adaptive-style models (Opus 4.7) the tier maps
                          to Anthropic's 'effort' parameter (low through max
                          all valid). The harness pins display='summarized'
                          for adaptive so the trace sidecar captures real
                          thinking content (Opus 4.7 defaults to 'omitted').
  EVAL_REASONING_BUDGET   override the per-request thinking budget
                          (positive integer ≥ 1024). Used alone, the
                          level is tagged 'custom'.

  When extended thinking is enabled, Anthropic requires temperature=1,
  so runs become non-deterministic — use --trials ≥ 3 to characterize
  variance.

Non-default vendor backends (select via EVAL_PROVIDER):
  EVAL_PROVIDER=openai
    OPENAI_API_KEY          required.
    EVAL_OPENAI_MODEL       required (e.g. 'gpt-5.5'). The pricing
                            catalog must carry a row for this model
                            (see PRICING_CATALOG.openai in
                            evals/harness/model.ts) — unknown models
                            throw at runtime.
    EVAL_OPENAI_BASE_URL    optional override (Azure / corporate gateway);
                            defaults to https://api.openai.com/v1.
    Reasoning-off (EVAL_REASONING_LEVEL=none) → /v1/chat/completions
    path (#50). Reasoning-on (any other level) → /v1/responses path
    (#58), which is GPT-5.5's only supported surface for tools +
    reasoning_effort. Tier mapping: low/medium/high/xhigh pass
    through; max clamps to xhigh (OpenAI's top tier).
  EVAL_PROVIDER=vertex
    EVAL_VERTEX_PROJECT_ID  required (or GOOGLE_CLOUD_PROJECT, which
                            the SDK reads natively — hosts already
                            wired for Vertex don't need a second var).
                            The GCP project that has Vertex API
                            enabled AND is allowlisted for the target
                            Gemini preview model.
    EVAL_VERTEX_LOCATION    optional; defaults to 'global'. Preview
                            3.x models (notably gemini-3.1-pro-preview)
                            ONLY resolve at 'global'; us-central1 etc.
                            404 even when the catalog lists the model.
    EVAL_VERTEX_MODEL_ID    optional; defaults to 'gemini-3.1-pro-preview'.
                            Preview ids rotate without long notice —
                            override here when Google retires the
                            named id. Pricing is looked up via
                            PRICING_CATALOG.vertex[model] in
                            evals/harness/model.ts; unknown models
                            throw at runtime.
    Auth: standard SDK paths (ADC via 'gcloud auth application-default
    login' OR a service-account JSON at GOOGLE_APPLICATION_CREDENTIALS).
    The adapter creates an explicit cachedContents resource per trial
    on prefix change and deletes it at scenario end — operator-visible
    on the GCP project. ADC setup:
    https://cloud.google.com/docs/authentication/application-default-credentials
  EVAL_PROVIDER=lm-studio
    EVAL_LM_STUDIO_BASE_URL, EVAL_LM_STUDIO_MODEL, EVAL_LM_STUDIO_API_KEY
    All required. Investigation-artifact path (issue #45) — see header
    of evals/harness/lm-studio-adapter.ts.
  EVAL_PROVIDER=deepseek                                          (LEO-233)
    EVAL_DEEPSEEK_API_KEY   required.
    EVAL_DEEPSEEK_MODEL     required (e.g. 'deepseek-v4-pro' /
                            'deepseek-v4-flash' — use the v4 ids; the
                            deepseek-chat/deepseek-reasoner aliases
                            deprecate 2026-07-24). PRICING_CATALOG.deepseek
                            must carry a row (unknown models throw).
    EVAL_DEEPSEEK_BASE_URL  optional; defaults to https://api.deepseek.com/v1.
    OpenAI-compatible Chat Completions (max_tokens, no Responses API).
    Reasoning ON via the nested 'thinking' object (always-on 'high', GH #8);
    reasoning_content captured to the .thinking sidecar but NOT re-fed (DeepSeek
    400s if it is in input — the mirror opposite of Kimi). Cache-read discount
    billed from prompt_cache_hit_tokens.
    Bills real money — set a low EVAL_BUDGET_USD and smoke eval:quick first.
  EVAL_PROVIDER=moonshot                                          (LEO-233)
    EVAL_MOONSHOT_API_KEY   required.
    EVAL_MOONSHOT_MODEL     required (e.g. 'kimi-k2.6' / 'kimi-k2.5').
                            PRICING_CATALOG.moonshot must carry a row.
    EVAL_MOONSHOT_BASE_URL  optional; defaults to https://api.moonshot.ai/v1
                            (the global .ai endpoint, not .cn). This is the
                            eval-harness /v1 path — distinct from the Kimi
                            Claude Code setup's /anthropic endpoint.
    OpenAI-compatible Chat Completions (max_tokens, no Responses API). K2
    Thinking reasons by Moonshot's DEFAULT; reasoning_content is captured AND
    re-fed on tool-call turns (K2 rejects a turn that omits it). Cache-read
    discount billed from prompt_tokens_details.cached_tokens. Bills real money.

Model pin:
  ${MODEL_ID} (level=${REASONING.level}${REASONING.budgetTokens ? `, budget=${REASONING.budgetTokens}` : ""}).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const outDir = join(args.outRoot, args.runId);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const provider = resolveProviderClient();
  const effectiveModel = provider?.model ?? MODEL_ID;
  const reasoningTag = REASONING.budgetTokens
    ? `reasoning=${REASONING.level}/${REASONING.budgetTokens}`
    : "reasoning=off";
  console.error(
    `L4 eval — model=${effectiveModel} ${reasoningTag} scenarios=[${args.scenarios.join(",")}] trials=${args.trials} budget=$${args.budgetUsd} out=${outDir}`,
  );

  const budget: BudgetTracker = { spentUsd: 0, ceilingUsd: args.budgetUsd };
  const byScenario: Record<string, TrialOutcome[]> = {};
  if (provider) {
    console.error(
      `[eval] EVAL_PROVIDER=${process.env.EVAL_PROVIDER} — using non-default backend. scenario_start.model = ${provider.model}.`,
    );
    if (provider.vendor === "lm-studio") {
      console.error(
        `[eval]   Caveat on this throwaway path (investigation artifact, issue #45):`,
      );
      console.error(
        `[eval]   - scenario_start.reasoning + effort are Anthropic-shaped from the harness defaults; the LM Studio adapter discards thinking/output_config, so these fields are NOT a faithful record of what the backend did.`,
      );
    }
    if (provider.vendor === "deepseek") {
      console.error(`[eval]   Caveat on this OpenAI-compat path (LEO-233 / GH #8):`);
      console.error(
        `[eval]   - DeepSeek V4 runs WITH reasoning on (the adapter sends thinking:{type:"enabled",reasoning_effort:"high"}); reasoning_content is captured to the .thinking sidecar but NOT re-fed (DeepSeek 400s if it is in input). But the harness tier (scenario_start.reasoning/effort, e.g. medium/8192) is NOT mapped to DeepSeek's effort — it's always 'high', so treat those depth fields as Anthropic-shaped defaults, not a faithful record.`,
      );
    }
    if (provider.vendor === "moonshot") {
      console.error(`[eval]   Caveat on this OpenAI-compat path (LEO-233):`);
      console.error(
        `[eval]   - Kimi K2 Thinking runs with Moonshot's DEFAULT thinking on; the adapter captures reasoning_content and round-trips it on tool-call turns (also written to the .thinking sidecar). But the harness tier (scenario_start.reasoning/effort, e.g. medium/8192) is NOT mapped to Moonshot's thinking depth — treat those depth fields as Anthropic-shaped defaults, not a faithful record.`,
      );
    }
    if (provider.vendor === "vertex") {
      console.error(
        `[eval]   Vertex adapter (#51): explicit cachedContents resource lifecycle — the adapter creates a cache on prefix change and deletes it at scenario end. Resource is operator-visible on the GCP project (gcloud beta ai cached-contents list).`,
      );
      console.error(
        `[eval]   Thinking round-trip: thoughtSignature carries Gemini's per-thought-part opaque blob through the assistant_msg → next-iter input — the trace file is self-contained (no server-state dependency on prior turns).`,
      );
      console.error(
        `[eval]   Pricing: gemini-3.1-pro-preview rates are PREVIEW — see model.ts PRICING_CATALOG.vertex header; operator should re-verify against the Vertex pricing page before any large real-money run.`,
      );
    }
    if (provider.vendor === "openai") {
      const reasoningOn = REASONING.level !== "none";
      console.error(
        `[eval]   OpenAI adapter: ${reasoningOn ? "Responses-API path (#58)" : "Chat Completions path (#50)"}. ${reasoningOn ? "reasoning.effort + reasoning.summary='auto' enabled; reasoning items round-trip via encrypted_content." : "Reasoning off — Chat Completions is the lower-overhead surface for non-reasoning trials."}`,
      );
      console.error(
        `[eval]   cacheTokens.cachedTokens populated from usage${reasoningOn ? ".input_tokens_details" : ".prompt_tokens_details"}.cached_tokens. Standard pricing (batch/flex/priority NOT modeled). Long-context tier ($10/$45 per Mtok = 2× input + 1.5× output) applies when prompt_tokens > 272K — per-iter trip warned on stderr, cost math swaps rates in estimateCostUsd.`,
      );
    }
  }

  for (const name of args.scenarios) {
    const scenario = lookupScenario(name);
    if (!existsSync(scenario.variantDir)) {
      throw new Error(
        `Scenario '${name}' references variantDir '${scenario.variantDir}' which does not exist. Run 'npm run sample:build' (canonical) or build the scenario's variant first.`,
      );
    }
    const outcomes: TrialOutcome[] = [];
    for (let trial = 1; trial <= args.trials; trial++) {
      try {
        const outcome = await runTrial({
          scenario,
          trial,
          outDir,
          budget,
          variantDistDir: scenario.variantDir,
          ...(provider ? { adapter: provider } : {}),
        });
        outcomes.push(outcome);
        const correct = outcome.oracle.correctness === 1 ? "PASS" : "FAIL";
        const mech = outcome.oracle.mechanic === 1 ? "PASS" : "FAIL";
        const xfailTag = scenario.xfailCorrectness ? " [xfail-correctness]" : "";
        console.error(
          `  ${scenario.name} trial ${trial}/${args.trials}: correct=${correct}${xfailTag} mechanic=${mech} cost=$${outcome.costUsd.toFixed(3)} elapsed=${outcome.elapsedMs}ms`,
        );
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          console.error(`  ABORTED at ${scenario.name} trial ${trial}: ${e.message}`);
          break;
        }
        throw e;
      }
    }
    byScenario[name] = outcomes;
    if (budget.spentUsd >= budget.ceilingUsd) {
      console.error(
        `Stopping: spent $${budget.spentUsd.toFixed(2)} of $${budget.ceilingUsd.toFixed(2)} budget.`,
      );
      break;
    }
  }

  // Rollup + scoreboard. Pass each scenario's xfailCorrectness flag
  // through to the rollup so XFAIL/XPASS are surfaced in place of
  // FAIL/PASS for tagged scenarios — adversarial-out-of-order being
  // the current (and only) example.
  const rollups = Object.entries(byScenario).map(([name, outcomes]) => {
    const scenario = lookupScenario(name);
    return rollupScenario(name, outcomes, {
      xfailCorrectness: scenario.xfailCorrectness,
    });
  });
  console.log("\n" + renderScoreboard(rollups));

  // Surface scenarios the budget cap (or another break) prevented from
  // producing any data — both "never started" AND "BudgetExceeded mid-
  // first-trial" (which leaves byScenario[name] = []) read the same to
  // the operator: we have no measurement here. Treat both as skipped so
  // a $100-cap trip at trial 17 doesn't silently roll into "FAIL" with
  // trials=0 (PR #15 review rev-2).
  const produced = new Set(
    Object.entries(byScenario)
      .filter(([, outcomes]) => outcomes.length > 0)
      .map(([name]) => name),
  );
  const skipped = args.scenarios.filter((s) => !produced.has(s));
  if (skipped.length > 0) {
    console.log(`\nskipped (budget halt or break, no trials produced): ${skipped.join(", ")}`);
  }

  // Exit code: only `FAIL` (correctness=0 on a non-xfail scenario)
  // fails the run. XFAIL is the expected outcome for xfail-tagged
  // scenarios; XPASS is an unexpected pass (operator should consider
  // removing the xfail tag) but does not flip the gate red.
  const allPassed =
    rollups.length === args.scenarios.length && rollups.every((r) => r.status !== "FAIL");
  process.exit(allPassed ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(2);
});
