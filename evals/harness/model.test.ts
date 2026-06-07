import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateCostUsd,
  MODEL_ID,
  pricingFor,
  PRICING_CATALOG,
  PRICING_PER_MTOK,
  readModelId,
  readReasoningBudget,
  readReasoningLevel,
  resolveReasoning,
  SUPPORTED_MODELS,
  TIER_BUDGET_TOKENS,
  tierToEffort,
} from "./model.js";

describe("estimateCostUsd", () => {
  // Compute the expected cost dynamically from PRICING_PER_MTOK so this
  // regression test survives a model override at the caller's shell —
  // e.g. `EVAL_MODEL_OVERRIDE=claude-opus-4-7 npm test` previously failed
  // here because the expected $0.485 was hardcoded against Sonnet 4.6
  // rates. The regression #16 was about the sign of the buckets, not the
  // absolute number; the relationship is what we want to assert.
  it("bills the four token buckets at their own rates (regression for #16)", () => {
    // Real numbers from evals/runs/2026-05-15T21-55-42-005Z compute-step trial.
    // Pre-fix this returned -$1.30 (negative, because cacheRead was subtracted
    // from inputTokens). Each bucket bills at its own rate; total must be > 0.
    const tokens = {
      inputTokens: 52_615,
      outputTokens: 2_487,
      cacheTokens: {
        cacheCreationInputTokens: 33_117,
        cacheReadInputTokens: 553_225,
      },
    };
    const cost = estimateCostUsd("anthropic", MODEL_ID, tokens);
    const expected =
      (tokens.inputTokens / 1_000_000) * PRICING_PER_MTOK.input +
      (tokens.cacheTokens.cacheCreationInputTokens / 1_000_000) * PRICING_PER_MTOK.inputCacheWrite +
      (tokens.cacheTokens.cacheReadInputTokens / 1_000_000) * PRICING_PER_MTOK.inputCacheRead +
      (tokens.outputTokens / 1_000_000) * PRICING_PER_MTOK.output;
    expect(cost).toBeCloseTo(expected, 6);
    expect(cost).toBeGreaterThan(0);
  });

  it("treats cache_creation and cache_read as disjoint from input_tokens (Anthropic)", () => {
    // 1M of each bucket → cost equals the rate card sum exactly.
    const cost = estimateCostUsd("anthropic", MODEL_ID, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheTokens: {
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      },
    });
    const expected =
      PRICING_PER_MTOK.input +
      PRICING_PER_MTOK.inputCacheWrite +
      PRICING_PER_MTOK.inputCacheRead +
      PRICING_PER_MTOK.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("treats absent / empty cacheTokens map as zero cache activity", () => {
    const costAbsent = estimateCostUsd("anthropic", MODEL_ID, {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const costEmpty = estimateCostUsd("anthropic", MODEL_ID, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheTokens: {},
    });
    expect(costAbsent).toBeCloseTo(PRICING_PER_MTOK.input, 6);
    expect(costEmpty).toBeCloseTo(PRICING_PER_MTOK.input, 6);
  });

  it("never returns a negative cost for any non-negative input", () => {
    const cost = estimateCostUsd("anthropic", MODEL_ID, {
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: { cacheReadInputTokens: 1_000_000_000 },
    });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("matches the explicit math for Opus 4.7 with both cache buckets populated", () => {
    // Pins the cross-bucket math against the Opus 4.7 rate card so a
    // future catalog refactor can't silently regress the formula.
    const tokens = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheTokens: {
        cacheCreationInputTokens: 10_000,
        cacheReadInputTokens: 500_000,
      },
    };
    const cost = estimateCostUsd("anthropic", "claude-opus-4-7", tokens);
    const row = PRICING_CATALOG.anthropic["claude-opus-4-7"]!;
    const expected =
      (tokens.inputTokens / 1_000_000) * row.input +
      (tokens.cacheTokens.cacheCreationInputTokens / 1_000_000) * row.inputCacheWrite! +
      (tokens.cacheTokens.cacheReadInputTokens / 1_000_000) * row.inputCacheRead! +
      (tokens.outputTokens / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("returns exactly 0 for any LM Studio model (wildcard sentinel)", () => {
    const cost = estimateCostUsd("lm-studio", "anything", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(0);
  });

  it("OpenAI: bills only the un-cached portion of input + cached at the discounted rate", () => {
    // OpenAI's `prompt_tokens` INCLUDES cached tokens (Anthropic's does
    // not). estimateCostUsd subtracts cached from input for the fresh-
    // input bucket, then bills cached at inputCacheRead. Pin the math
    // for GPT-5.5 against the rate card. Token counts deliberately
    // sub-threshold (< 272K) so this exercises the standard-rate
    // path; the long-context branch is covered separately below.
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    expect(row).toBeDefined();
    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheTokens: { cachedTokens: 70_000 },
    });
    const expected =
      ((100_000 - 70_000) / 1_000_000) * row.input +
      (70_000 / 1_000_000) * row.inputCacheRead! +
      (50_000 / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("OpenAI: with no cachedTokens, full inputTokens are billed at the fresh rate", () => {
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    // 100K input — well under the 272K long-context threshold.
    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo((100_000 / 1_000_000) * row.input, 6);
  });

  it("OpenAI: clamps at zero when cachedTokens exceeds inputTokens (defensive)", () => {
    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 100,
      outputTokens: 0,
      cacheTokens: { cachedTokens: 999_999 },
    });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("DeepSeek: bills the cached portion at inputCacheRead, the rest at input (LEO-233 §3)", () => {
    // DeepSeek's prompt_tokens INCLUDES the cache-hit portion (surfaced as
    // `cachedTokens`); estimateCostUsd subtracts it before billing fresh input.
    const row = PRICING_CATALOG.deepseek["deepseek-v4-pro"]!;
    const cost = estimateCostUsd("deepseek", "deepseek-v4-pro", {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheTokens: { cachedTokens: 70_000 },
    });
    const expected =
      ((100_000 - 70_000) / 1_000_000) * row.input +
      (70_000 / 1_000_000) * row.inputCacheRead! +
      (20_000 / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("DeepSeek: with no cache hit, full input bills at the fresh rate", () => {
    const row = PRICING_CATALOG.deepseek["deepseek-v4-pro"]!;
    const cost = estimateCostUsd("deepseek", "deepseek-v4-pro", {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo((100_000 / 1_000_000) * row.input, 6);
  });

  it("Moonshot: bills the cached portion at inputCacheRead, the rest at input (LEO-233 §3)", () => {
    const row = PRICING_CATALOG.moonshot["kimi-k2.6"]!;
    const cost = estimateCostUsd("moonshot", "kimi-k2.6", {
      inputTokens: 80_000,
      outputTokens: 10_000,
      cacheTokens: { cachedTokens: 50_000 },
    });
    const expected =
      ((80_000 - 50_000) / 1_000_000) * row.input +
      (50_000 / 1_000_000) * row.inputCacheRead! +
      (10_000 / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("OpenAI: GPT-5.5 long-context tier swaps rates ($10/$45 = 2× input, 1.5× output) when inputTokens > threshold", () => {
    // PR #60 reviews: GPT-5.5 bills WHOLE-request at 2× input + 1.5×
    // output for prompts above 272K input tokens. From the $5/$30
    // base, that's $10/$45.
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    expect(row.longContextThresholdTokens).toBe(272_000);
    expect(row.longContextInput).toBe(10.0);
    expect(row.longContextOutput).toBe(45.0);
    expect(row.longContextInput).toBeCloseTo(row.input * 2, 6);
    expect(row.longContextOutput).toBeCloseTo(row.output * 1.5, 6);

    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 272_001,
      outputTokens: 1_000,
    });
    const expected =
      (272_001 / 1_000_000) * row.longContextInput! +
      (1_000 / 1_000_000) * row.longContextOutput!;
    expect(cost).toBeCloseTo(expected, 6);
    // Sanity: long-context bill > standard-rate bill on the same tokens.
    const standardEquivalent =
      (272_001 / 1_000_000) * row.input + (1_000 / 1_000_000) * row.output;
    expect(cost).toBeGreaterThan(standardEquivalent);
  });

  it("OpenAI: at exactly the threshold (=, not >), standard rates still apply", () => {
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 272_000,
      outputTokens: 1_000,
    });
    const expected =
      (272_000 / 1_000_000) * row.input + (1_000 / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("OpenAI long-context: cached portion bills at the long-context cache rate ($1/Mtok = 2× short-context cache)", () => {
    // PR #60 re-review (gpt-5 #1): the GPT-5.5 row sets
    // longContextInputCacheRead = $1 (2× the short-context cache rate,
    // matching the 2× input multiplier). Pre-fix shape fell back to
    // short-context $0.50, which UNDER-bills cached input under the
    // long-context tier.
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    expect(row.longContextInputCacheRead).toBe(1.0);
    const cost = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 300_000,
      outputTokens: 0,
      cacheTokens: { cachedTokens: 200_000 },
    });
    const expected =
      ((300_000 - 200_000) / 1_000_000) * row.longContextInput! +
      (200_000 / 1_000_000) * row.longContextInputCacheRead!;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("OpenAI per-iter billing semantics: 3 × 100K iters bill at standard rates (none crossed 272K individually)", () => {
    // PR #60 re-review (gpt-5 #2): the runner accumulates cost
    // per-iteration, so a session whose ITERATIONS each stay below
    // 272K should bill at standard rates even if cumulative totals
    // cross the threshold. This test pins the per-iter math by
    // calling estimateCostUsd three times (one per simulated iter)
    // with sub-threshold individual inputs, summing the result, and
    // comparing to what totals-based billing would have produced.
    const row = PRICING_CATALOG.openai["gpt-5.5"]!;
    const perIter = (inputTokens: number, outputTokens: number) =>
      estimateCostUsd("openai", "gpt-5.5", { inputTokens, outputTokens });

    const perIterSum = perIter(100_000, 50) + perIter(100_000, 50) + perIter(100_000, 50);
    const totalsBased = estimateCostUsd("openai", "gpt-5.5", {
      inputTokens: 300_000,
      outputTokens: 150,
    });

    // Per-iter: 3 × (100K * $5/Mtok + 50 * $30/Mtok) = 3 × (0.5 + 0.0015) = $1.5045
    const expectedPerIter =
      3 * ((100_000 / 1_000_000) * row.input + (50 / 1_000_000) * row.output);
    expect(perIterSum).toBeCloseTo(expectedPerIter, 6);
    // Totals-based (the pre-#19 bug): treats cumulative 300K > 272K as
    // long-context-eligible → bills at $10/$45. Bigger; that
    // overcharge is what gpt-5's re-review caught.
    expect(totalsBased).toBeGreaterThan(perIterSum);
  });

  it("Vertex: bills only the un-cached portion of input + cached at the discounted rate (#51)", () => {
    // Same shape as OpenAI: Gemini's promptTokenCount INCLUDES cached
    // tokens. estimateCostUsd subtracts cached from input for the
    // fresh-input bucket, then bills cached at inputCacheRead. Pin the
    // math against gemini-3.1-pro-preview's standard-tier rates.
    // Token counts deliberately sub-threshold (< 200K).
    const row = PRICING_CATALOG.vertex["gemini-3.1-pro-preview"]!;
    expect(row).toBeDefined();
    const cost = estimateCostUsd("vertex", "gemini-3.1-pro-preview", {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheTokens: { cachedContentTokens: 60_000 },
    });
    const expected =
      ((100_000 - 60_000) / 1_000_000) * row.input +
      (60_000 / 1_000_000) * row.inputCacheRead! +
      (20_000 / 1_000_000) * row.output;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("Vertex: long-context tier swaps input + cache-read + output rates above 200K input (per pricing-page footnote)", () => {
    // Gemini 3.1 Pro Preview tiers at 200K. Input + cached double
    // (2×); output goes from $12 → $18 (1.5×). The pricing-page
    // footnote: "If a query input context is longer than 200K tokens,
    // all tokens (input and output) are charged at long context
    // rates." Codex PR #62 review caught an earlier draft that left
    // longContextOutput undefined based on a stale page summary —
    // would have underbilled output by 33% on every >200K iter.
    const row = PRICING_CATALOG.vertex["gemini-3.1-pro-preview"]!;
    expect(row.longContextThresholdTokens).toBe(200_000);
    expect(row.longContextInput).toBeCloseTo(row.input * 2, 6);
    expect(row.longContextInputCacheRead).toBeCloseTo(row.inputCacheRead! * 2, 6);
    expect(row.longContextOutput).toBeCloseTo(row.output * 1.5, 6);

    const cost = estimateCostUsd("vertex", "gemini-3.1-pro-preview", {
      inputTokens: 250_000,
      outputTokens: 1_000,
      cacheTokens: { cachedContentTokens: 150_000 },
    });
    // Long-context branch: input + cached + output all swap to the
    // long-context rates.
    const expected =
      ((250_000 - 150_000) / 1_000_000) * row.longContextInput! +
      (150_000 / 1_000_000) * row.longContextInputCacheRead! +
      (1_000 / 1_000_000) * row.longContextOutput!;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("throws on a row with `tiers !== undefined` (forcing function for future bucket-ladder tiers)", () => {
    // Inject a tiered row into the otherwise-flat-priced openai sub-map
    // to exercise the throw path without mutating production rows. The
    // pre-#50 message named #50/#51; #50 landed with flat pricing only,
    // so the message now points only at #51 (Vertex context-length tiers).
    PRICING_CATALOG.openai["__test-tiered-row__"] = {
      input: 0,
      output: 0,
      tiers: [{ upTo: 1_000_000, pricePerMTok: 1 }],
    };
    try {
      expect(() =>
        estimateCostUsd("openai", "__test-tiered-row__", {
          inputTokens: 100,
          outputTokens: 100,
        }),
      ).toThrow(/tiered pricing not yet implemented/);
    } finally {
      delete PRICING_CATALOG.openai["__test-tiered-row__"];
    }
  });
});

describe("pricingFor", () => {
  it("returns the lm-studio wildcard sentinel for any model id", () => {
    const row = pricingFor("lm-studio", "any-model");
    expect(row.input).toBe(0);
    expect(row.output).toBe(0);
  });

  it("wildcard matches model ids containing slashes (openai-style names)", () => {
    const row = pricingFor("lm-studio", "openai/gpt-oss-120b");
    expect(row.input).toBe(0);
    expect(row.output).toBe(0);
  });

  it("returns the exact Anthropic row for a known model", () => {
    const row = pricingFor("anthropic", "claude-opus-4-7");
    expect(row).toEqual(PRICING_CATALOG.anthropic["claude-opus-4-7"]);
  });

  it("throws with both vendor and model in the message on an unknown Anthropic model", () => {
    expect(() => pricingFor("anthropic", "claude-imaginary-99")).toThrow(/anthropic/);
    expect(() => pricingFor("anthropic", "claude-imaginary-99")).toThrow(/claude-imaginary-99/);
  });

  it("throws when an OpenAI model has no pricing row and the sub-map has no sentinel", () => {
    // Post-#50 the openai sub-map is non-empty (gpt-5.5 lands), but
    // lookups for unrecognized models still throw rather than fall back.
    expect(() => pricingFor("openai", "gpt-imaginary-99")).toThrow(/openai/);
    expect(() => pricingFor("openai", "gpt-imaginary-99")).toThrow(/gpt-imaginary-99/);
  });

  it("throws when a Vertex model has no pricing row and the sub-map has no sentinel", () => {
    // Post-#51 the vertex sub-map is non-empty (gemini-3.1-pro-preview
    // lands), but lookups for unrecognized models still throw rather
    // than fall back to a wildcard.
    expect(() => pricingFor("vertex", "gemini-imaginary-99")).toThrow(/vertex/);
    expect(() => pricingFor("vertex", "gemini-imaginary-99")).toThrow(/gemini-imaginary-99/);
  });

  it("returns the gpt-5.5 row for openai (added in #50)", () => {
    const row = pricingFor("openai", "gpt-5.5");
    expect(row.input).toBe(5.0);
    expect(row.inputCacheRead).toBe(0.5);
    expect(row.output).toBe(30.0);
    expect(row.inputCacheWrite).toBeUndefined();
  });

  it("returns the gemini-3.1-pro-preview row for vertex (added in #51)", () => {
    const row = pricingFor("vertex", "gemini-3.1-pro-preview");
    // Gemini 3.1 Pro Preview standard rates fetched from
    // cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
    // 2026-05-18 (re-verified during Codex PR #62 review). Both input
    // AND output tier at 200K input tokens — pricing-page footnote:
    // "If a query input context is longer than 200K tokens, all tokens
    // (input and output) are charged at long context rates."
    expect(row.input).toBe(2.0);
    expect(row.inputCacheRead).toBe(0.20);
    expect(row.output).toBe(12.0);
    expect(row.longContextThresholdTokens).toBe(200_000);
    expect(row.longContextInput).toBe(4.0);
    expect(row.longContextInputCacheRead).toBe(0.40);
    expect(row.longContextOutput).toBe(18.0);
  });

  it("returns deepseek v4 rows with a cache-read bucket (LEO-233 §3)", () => {
    const pro = pricingFor("deepseek", "deepseek-v4-pro");
    expect(pro.input).toBe(1.74);
    expect(pro.inputCacheRead).toBe(0.0145);
    expect(pro.output).toBe(3.48);
    expect(pro.inputCacheWrite).toBeUndefined();
    const flash = pricingFor("deepseek", "deepseek-v4-flash");
    expect(flash.input).toBe(0.14);
    expect(flash.inputCacheRead).toBe(0.0028);
    expect(flash.output).toBe(0.28);
  });

  it("returns moonshot kimi rows with a cache-read bucket (LEO-233 §3)", () => {
    const k26 = pricingFor("moonshot", "kimi-k2.6");
    expect(k26.input).toBe(0.95);
    expect(k26.inputCacheRead).toBe(0.16);
    expect(k26.output).toBe(4.0);
    const k25 = pricingFor("moonshot", "kimi-k2.5");
    expect(k25.input).toBe(0.6);
    expect(k25.inputCacheRead).toBe(0.1);
    expect(k25.output).toBe(2.5);
  });
});

describe("readReasoningBudget", () => {
  const original = process.env.EVAL_REASONING_BUDGET;

  beforeEach(() => {
    delete process.env.EVAL_REASONING_BUDGET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_REASONING_BUDGET;
    else process.env.EVAL_REASONING_BUDGET = original;
  });

  it("returns null when EVAL_REASONING_BUDGET is unset", () => {
    expect(readReasoningBudget()).toBeNull();
  });

  it("returns null when EVAL_REASONING_BUDGET is empty", () => {
    process.env.EVAL_REASONING_BUDGET = "";
    expect(readReasoningBudget()).toBeNull();
  });

  it("returns the integer when set to a valid value at or above 1024", () => {
    process.env.EVAL_REASONING_BUDGET = "16000";
    expect(readReasoningBudget()).toBe(16000);
    process.env.EVAL_REASONING_BUDGET = "1024";
    expect(readReasoningBudget()).toBe(1024);
  });

  it("throws when below the Anthropic 1024-token floor", () => {
    process.env.EVAL_REASONING_BUDGET = "1023";
    expect(() => readReasoningBudget()).toThrow(/positive integer/);
  });

  it("throws on non-numeric, negative, zero, or non-integer values", () => {
    for (const bad of ["foo", "-1", "0", "3.14", "NaN"]) {
      process.env.EVAL_REASONING_BUDGET = bad;
      expect(() => readReasoningBudget(), `value '${bad}'`).toThrow(/EVAL_REASONING_BUDGET/);
    }
  });
});

describe("readReasoningLevel", () => {
  const original = process.env.EVAL_REASONING_LEVEL;

  beforeEach(() => {
    delete process.env.EVAL_REASONING_LEVEL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_REASONING_LEVEL;
    else process.env.EVAL_REASONING_LEVEL = original;
  });

  it("returns null when unset or empty", () => {
    expect(readReasoningLevel()).toBeNull();
    process.env.EVAL_REASONING_LEVEL = "";
    expect(readReasoningLevel()).toBeNull();
  });

  it("returns 'none' explicitly", () => {
    process.env.EVAL_REASONING_LEVEL = "none";
    expect(readReasoningLevel()).toBe("none");
  });

  it("accepts every tier name", () => {
    for (const tier of Object.keys(TIER_BUDGET_TOKENS)) {
      process.env.EVAL_REASONING_LEVEL = tier;
      expect(readReasoningLevel()).toBe(tier);
    }
  });

  it("throws on unknown values with a message listing allowed tiers", () => {
    process.env.EVAL_REASONING_LEVEL = "ultra";
    expect(() => readReasoningLevel()).toThrow(/EVAL_REASONING_LEVEL/);
    expect(() => readReasoningLevel()).toThrow(/'low'/);
    expect(() => readReasoningLevel()).toThrow(/'max'/);
  });
});

describe("readModelId", () => {
  const original = process.env.EVAL_MODEL_OVERRIDE;

  beforeEach(() => {
    delete process.env.EVAL_MODEL_OVERRIDE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = original;
  });

  it("returns the default model when EVAL_MODEL_OVERRIDE is unset", () => {
    expect(readModelId()).toBe("claude-opus-4-7");
  });

  it("returns the default model when EVAL_MODEL_OVERRIDE is empty", () => {
    process.env.EVAL_MODEL_OVERRIDE = "";
    expect(readModelId()).toBe("claude-opus-4-7");
  });

  it("accepts every supported model id", () => {
    for (const model of SUPPORTED_MODELS) {
      process.env.EVAL_MODEL_OVERRIDE = model;
      expect(readModelId()).toBe(model);
    }
  });

  it("throws on unknown values with a message listing supported ids", () => {
    process.env.EVAL_MODEL_OVERRIDE = "claude-opus-4-1";
    expect(() => readModelId()).toThrow(/EVAL_MODEL_OVERRIDE/);
    expect(() => readModelId()).toThrow(/'claude-sonnet-4-6'/);
    expect(() => readModelId()).toThrow(/'claude-opus-4-7'/);
  });
});

describe("PRICING_CATALOG", () => {
  it("has a pricing row for every supported Anthropic model", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(PRICING_CATALOG.anthropic[model]).toBeDefined();
      const p = PRICING_CATALOG.anthropic[model]!;
      expect(p.input).toBeGreaterThan(0);
      expect(p.inputCacheWrite).toBeGreaterThan(0);
      expect(p.inputCacheRead).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(0);
    }
  });

  it("Opus 4.7 is more expensive than Sonnet 4.6 (regression for the catalog)", () => {
    expect(PRICING_CATALOG.anthropic["claude-opus-4-7"]!.input).toBeGreaterThan(
      PRICING_CATALOG.anthropic["claude-sonnet-4-6"]!.input,
    );
    expect(PRICING_CATALOG.anthropic["claude-opus-4-7"]!.output).toBeGreaterThan(
      PRICING_CATALOG.anthropic["claude-sonnet-4-6"]!.output,
    );
  });

  it("cache-write is 1.25× input and cache-read is 0.1× input per Anthropic's documented multipliers", () => {
    for (const model of SUPPORTED_MODELS) {
      const p = PRICING_CATALOG.anthropic[model]!;
      expect(p.inputCacheWrite!).toBeCloseTo(p.input * 1.25, 6);
      expect(p.inputCacheRead!).toBeCloseTo(p.input * 0.1, 6);
    }
  });

  it("registers a wildcard sentinel for lm-studio (zero-pricing)", () => {
    const row = PRICING_CATALOG["lm-studio"]["*"];
    expect(row).toBeDefined();
    expect(row!.input).toBe(0);
    expect(row!.output).toBe(0);
  });
});

describe("SUPPORTS_TEMPERATURE", () => {
  const original = process.env.EVAL_MODEL_OVERRIDE;

  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = original;
    vi.resetModules();
  });

  it("is true for Sonnet 4.6 (selectable via EVAL_MODEL_OVERRIDE)", async () => {
    vi.resetModules();
    process.env.EVAL_MODEL_OVERRIDE = "claude-sonnet-4-6";
    const mod = await import("./model.js");
    expect(mod.SUPPORTS_TEMPERATURE).toBe(true);
  });

  it("is false for Opus 4.7 (default model — server-side sampling, rejects temperature param)", async () => {
    vi.resetModules();
    delete process.env.EVAL_MODEL_OVERRIDE;
    const mod = await import("./model.js");
    expect(mod.SUPPORTS_TEMPERATURE).toBe(false);
  });
});

describe("PRICING_PER_MTOK resolves via EVAL_MODEL_OVERRIDE at module load", () => {
  const original = process.env.EVAL_MODEL_OVERRIDE;

  afterEach(() => {
    if (original === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = original;
    vi.resetModules();
  });

  it("PRICING_PER_MTOK matches PRICING_CATALOG.anthropic[MODEL_ID] when the override is set", async () => {
    vi.resetModules();
    process.env.EVAL_MODEL_OVERRIDE = "claude-sonnet-4-6";
    const mod = await import("./model.js");
    expect(mod.MODEL_ID).toBe("claude-sonnet-4-6");
    expect(mod.PRICING_PER_MTOK).toEqual(mod.PRICING_CATALOG.anthropic["claude-sonnet-4-6"]);
  });

  it("PRICING_PER_MTOK falls back to the default catalog entry when override is unset", async () => {
    vi.resetModules();
    delete process.env.EVAL_MODEL_OVERRIDE;
    const mod = await import("./model.js");
    expect(mod.MODEL_ID).toBe("claude-opus-4-7");
    expect(mod.PRICING_PER_MTOK).toEqual(mod.PRICING_CATALOG.anthropic["claude-opus-4-7"]);
  });
});

describe("resolveReasoning — LEVEL × BUDGET truth table", () => {
  const originalLevel = process.env.EVAL_REASONING_LEVEL;
  const originalBudget = process.env.EVAL_REASONING_BUDGET;

  beforeEach(() => {
    delete process.env.EVAL_REASONING_LEVEL;
    delete process.env.EVAL_REASONING_BUDGET;
  });
  afterEach(() => {
    if (originalLevel === undefined) delete process.env.EVAL_REASONING_LEVEL;
    else process.env.EVAL_REASONING_LEVEL = originalLevel;
    if (originalBudget === undefined) delete process.env.EVAL_REASONING_BUDGET;
    else process.env.EVAL_REASONING_BUDGET = originalBudget;
  });

  it("LEVEL unset + BUDGET unset → tier-medium on the default (adaptive) model", () => {
    // The default model (Opus 4.7) is adaptive-style, so the "both unset"
    // branch picks medium-effort thinking rather than off. Adaptive vs
    // budget branching of this default is covered separately below via
    // vi.resetModules + EVAL_MODEL_OVERRIDE.
    expect(resolveReasoning()).toEqual({
      level: "medium",
      budgetTokens: TIER_BUDGET_TOKENS.medium,
    });
  });

  it("LEVEL=high + BUDGET unset → tier default", () => {
    process.env.EVAL_REASONING_LEVEL = "high";
    expect(resolveReasoning()).toEqual({
      level: "high",
      budgetTokens: TIER_BUDGET_TOKENS.high,
    });
  });

  it("LEVEL unset + BUDGET=N → custom", () => {
    process.env.EVAL_REASONING_BUDGET = "5000";
    expect(resolveReasoning()).toEqual({ level: "custom", budgetTokens: 5000 });
  });

  it("LEVEL=high + BUDGET=N → tier label with explicit budget override", () => {
    process.env.EVAL_REASONING_LEVEL = "high";
    process.env.EVAL_REASONING_BUDGET = "20000";
    expect(resolveReasoning()).toEqual({ level: "high", budgetTokens: 20000 });
  });

  it("LEVEL=none + BUDGET unset → { level: 'none' }", () => {
    process.env.EVAL_REASONING_LEVEL = "none";
    expect(resolveReasoning()).toEqual({ level: "none" });
  });

  it("LEVEL=none + BUDGET=N → throws (contradictory)", () => {
    process.env.EVAL_REASONING_LEVEL = "none";
    process.env.EVAL_REASONING_BUDGET = "8000";
    expect(() => resolveReasoning()).toThrow(/contradictory/);
  });

  it("every tier composes with its default budget", () => {
    for (const tier of Object.keys(TIER_BUDGET_TOKENS) as Array<
      keyof typeof TIER_BUDGET_TOKENS
    >) {
      process.env.EVAL_REASONING_LEVEL = tier;
      expect(resolveReasoning()).toEqual({
        level: tier,
        budgetTokens: TIER_BUDGET_TOKENS[tier],
      });
    }
  });
});

describe("resolveReasoning per-thinking-style defaults", () => {
  const originalModel = process.env.EVAL_MODEL_OVERRIDE;
  const originalLevel = process.env.EVAL_REASONING_LEVEL;
  const originalBudget = process.env.EVAL_REASONING_BUDGET;

  beforeEach(() => {
    delete process.env.EVAL_REASONING_LEVEL;
    delete process.env.EVAL_REASONING_BUDGET;
  });
  afterEach(() => {
    if (originalModel === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = originalModel;
    if (originalLevel === undefined) delete process.env.EVAL_REASONING_LEVEL;
    else process.env.EVAL_REASONING_LEVEL = originalLevel;
    if (originalBudget === undefined) delete process.env.EVAL_REASONING_BUDGET;
    else process.env.EVAL_REASONING_BUDGET = originalBudget;
    vi.resetModules();
  });

  it("adaptive-style default (Opus 4.7) → medium-effort tier when both env vars unset", async () => {
    vi.resetModules();
    delete process.env.EVAL_MODEL_OVERRIDE;
    const mod = await import("./model.js");
    expect(mod.THINKING_STYLE).toBe("adaptive");
    expect(mod.resolveReasoning()).toEqual({
      level: "medium",
      budgetTokens: mod.TIER_BUDGET_TOKENS.medium,
    });
  });

  it("budget-style (Sonnet 4.6 via override) → { level: 'none' } when both env vars unset", async () => {
    vi.resetModules();
    process.env.EVAL_MODEL_OVERRIDE = "claude-sonnet-4-6";
    const mod = await import("./model.js");
    expect(mod.THINKING_STYLE).toBe("budget");
    expect(mod.resolveReasoning()).toEqual({ level: "none" });
  });

  it("explicit EVAL_REASONING_LEVEL=none overrides the adaptive default", async () => {
    vi.resetModules();
    delete process.env.EVAL_MODEL_OVERRIDE;
    process.env.EVAL_REASONING_LEVEL = "none";
    const mod = await import("./model.js");
    expect(mod.resolveReasoning()).toEqual({ level: "none" });
  });
});

describe("tierToEffort", () => {
  // The five first-class tiers pass through unchanged; `custom` (the
  // env path where EVAL_REASONING_BUDGET is set without a level) maps
  // to `high` so adaptive-style models still get a defensible effort.
  // Pre-#47 the same contract was verified end-to-end via
  // buildMessageRequest in runner.test.ts; after the seam refactor the
  // runner is the only caller, so pin the mapping here directly.
  it("passes through the five first-class tiers", () => {
    expect(tierToEffort("low")).toBe("low");
    expect(tierToEffort("medium")).toBe("medium");
    expect(tierToEffort("high")).toBe("high");
    expect(tierToEffort("xhigh")).toBe("xhigh");
    expect(tierToEffort("max")).toBe("max");
  });

  it("maps 'custom' (budget-only env path) to 'high' for adaptive models", () => {
    expect(tierToEffort("custom")).toBe("high");
  });
});
