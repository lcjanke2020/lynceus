// Model + reasoning configuration for the L4 eval harness.
//
// Single source of truth — bump from one constant, never sprinkled.
// A planned day-of-week model rotation builds on top of the
// EVAL_MODEL_OVERRIDE env added here — once the rotation work lands,
// MODEL_ID will be a function of `new Date().getUTCDay()` plus this env.
//
// **Default model: opus-4.7 + adaptive `medium` thinking.** Switched
// from Sonnet 4.6 once real-money runs landed ~5× under the original
// $50–100/run estimate (Sonnet 4.6 nightly came in at ~$5–10). Opus 4.7
// with medium-effort adaptive thinking is the operator's preferred
// signal for "what should the nightly look like" — higher-quality
// traces inform the rotation proposal (PR #12). Sonnet 4.6 remains
// selectable via EVAL_MODEL_OVERRIDE for cheap ad-hoc runs.

import type { ReasoningConfig } from "./types.js";
import type { Vendor } from "./vendor.js";

/** Models the harness knows how to bill. Adding a model = add an entry
 *  to PRICING_CATALOG below + this union. Forces "we have pricing for
 *  this" at the type level — prevents "ran Opus, got Sonnet-priced cost
 *  numbers" silent failures. */
export const SUPPORTED_MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

const DEFAULT_MODEL_ID: SupportedModel = "claude-opus-4-7";

function isSupportedModel(s: string): s is SupportedModel {
  return (SUPPORTED_MODELS as readonly string[]).includes(s);
}

export function readModelId(): SupportedModel {
  const env = process.env.EVAL_MODEL_OVERRIDE;
  if (env === undefined || env === "") return DEFAULT_MODEL_ID;
  if (isSupportedModel(env)) return env;
  throw new Error(
    `EVAL_MODEL_OVERRIDE must be one of ${SUPPORTED_MODELS.map((m) => `'${m}'`).join(", ")}, got '${env}'. Unset to use the default ('${DEFAULT_MODEL_ID}').`,
  );
}

/** The active model — public ID. Plan rev-1 fold of Codex Low #3 (drop
 *  any internal `[1m]` variant tag so the harness is portable). Resolved
 *  at module load via `readModelId()`; downstream consumers
 *  (`cli.ts`, `runner.ts`) treat it as a const. */
export const MODEL_ID: SupportedModel = readModelId();

/** Models that no longer accept the `temperature` API parameter (the
 *  server picks sampling). Sending temperature on these returns
 *  `400 invalid_request_error: '`temperature` is deprecated for this model'`.
 *
 *  Empirically observed on Opus 4.7 — sending `temperature: 0` (the
 *  harness's pre-PR-#27 default) fails immediately. The pricing page's
 *  Opus 4.7 tokenizer note hints at API-surface changes for the new
 *  generation; treat this set as "newer Anthropic models we've actually
 *  seen reject the field," not as a forward-looking guess. Update when
 *  bumping models. */
const MODELS_WITHOUT_TEMPERATURE: ReadonlySet<SupportedModel> = new Set<SupportedModel>([
  "claude-opus-4-7",
]);

/** Whether the active model accepts the `temperature` parameter. Used
 *  by `buildMessageRequest` to omit it for models that 400 on it. */
export const SUPPORTS_TEMPERATURE: boolean = !MODELS_WITHOUT_TEMPERATURE.has(MODEL_ID);

/** Extended-thinking API shape. Anthropic's API split as of Opus 4.7:
 *
 *  - `budget` — legacy `thinking: { type: "enabled", budget_tokens: N }`.
 *    Caller specifies an explicit token budget per request. Supported on
 *    Sonnet 4.6 and older.
 *  - `adaptive` — new `thinking: { type: "adaptive" }` + `output_config:
 *    { effort: "low"|"medium"|"high" }`. Model auto-allocates thinking
 *    based on effort tier. Only style supported on Opus 4.7 (manual
 *    `enabled` returns 400).
 *
 *  The harness honors the same `EVAL_REASONING_LEVEL` env on both
 *  styles — `low`/`medium`/`high` map directly to effort tiers, and
 *  `xhigh`/`max` clamp down to `"high"` (the highest adaptive level).
 *  `custom` (budget-only env path) is a no-op on adaptive models —
 *  there's nothing for the operator to override. */
export type ThinkingStyle = "budget" | "adaptive";

const MODEL_THINKING_STYLE: Record<SupportedModel, ThinkingStyle> = {
  "claude-sonnet-4-6": "budget",
  "claude-opus-4-7": "adaptive",
};

export const THINKING_STYLE: ThinkingStyle = MODEL_THINKING_STYLE[MODEL_ID];

/** Map the harness's tier vocabulary to Anthropic's adaptive `effort`
 *  values. `low` | `medium` | `high` | `xhigh` | `max` pass through —
 *  all five are valid effort tiers on Claude Opus 4.7 (and the lower
 *  four on Opus 4.6 / Sonnet 4.6) per Anthropic's adaptive-thinking
 *  docs. `custom` (budget-only env path) is undefined for adaptive
 *  models since there's no budget to honor; map to the default `high`
 *  rather than throw, on the theory that the operator wanted SOME
 *  thinking. Used only when `THINKING_STYLE === "adaptive"`. */
export function tierToEffort(
  level: "low" | "medium" | "high" | "xhigh" | "max" | "custom",
): "low" | "medium" | "high" | "xhigh" | "max" {
  if (level === "custom") return "high";
  return level;
}

/** Reasoning configuration. Default depends on the active model's
 *  thinking style: adaptive-style models (Opus 4.7+) default to `medium`
 *  effort; budget-style models (Sonnet 4.6) default to `none`.
 *
 *  Two env vars compose the runtime config:
 *
 *  - `EVAL_REASONING_LEVEL` — tier name. One of:
 *    `none` | `low` | `medium` | `high` | `xhigh` | `max`. Each tier has
 *    a default budget defined in `TIER_BUDGET_TOKENS` below.
 *  - `EVAL_REASONING_BUDGET` — explicit `budget_tokens` (positive integer
 *    ≥ 1024, Anthropic's floor).
 *
 *  Resolution (where the "default" branch depends on THINKING_STYLE):
 *
 *  | LEVEL    | BUDGET | Result                                                |
 *  | -------- | ------ | ----------------------------------------------------- |
 *  | unset    | unset  | `{ level: "medium", budgetTokens: medium-default }`   |
 *  |          |        | on adaptive models; `{ level: "none" }` on budget.    |
 *  | tier     | unset  | `{ level: tier, budgetTokens: tier-default }`         |
 *  | unset    | N      | `{ level: "custom", budgetTokens: N }`                |
 *  | tier     | N      | `{ level: tier, budgetTokens: N }` (override)         |
 *  | "none"   | N      | throw (contradictory)                                 |
 *
 *  The `"custom"` label is reserved for budget-only invocations so the
 *  rotation work's tier vocabulary (`low`..`max`) stays clean for
 *  analytics over NDJSON traces. */
const MIN_THINKING_BUDGET_TOKENS = 1024;

/** Default `budget_tokens` per tier. The rotation proposal (PR #12) will
 *  refine these once it picks final numbers; these are starting points
 *  chosen for Sonnet 4.6 with `high` anchored at 16K (matches the
 *  2026-05-16 data-gathering run). */
export const TIER_BUDGET_TOKENS = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
} as const;

type TierName = keyof typeof TIER_BUDGET_TOKENS;
const TIER_NAMES = Object.keys(TIER_BUDGET_TOKENS) as readonly TierName[];

function isTierName(s: string): s is TierName {
  return (TIER_NAMES as readonly string[]).includes(s);
}

export function readReasoningLevel(): "none" | TierName | null {
  const env = process.env.EVAL_REASONING_LEVEL;
  if (env === undefined || env === "") return null;
  if (env === "none") return "none";
  if (isTierName(env)) return env;
  throw new Error(
    `EVAL_REASONING_LEVEL must be one of 'none', ${TIER_NAMES.map((t) => `'${t}'`).join(", ")}, got '${env}'. Unset to use the default (extended thinking disabled).`,
  );
}

export function readReasoningBudget(): number | null {
  const env = process.env.EVAL_REASONING_BUDGET;
  if (env === undefined || env === "") return null;
  const n = Number(env);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_THINKING_BUDGET_TOKENS) {
    throw new Error(
      `EVAL_REASONING_BUDGET must be a positive integer ≥ ${MIN_THINKING_BUDGET_TOKENS} (Anthropic's budget_tokens floor), got '${env}'. Unset to use the tier default or disable extended thinking.`,
    );
  }
  return n;
}

export function resolveReasoning(): ReasoningConfig {
  const level = readReasoningLevel();
  const budget = readReasoningBudget();

  if (level === "none" && budget !== null) {
    throw new Error(
      `EVAL_REASONING_LEVEL='none' is contradictory with EVAL_REASONING_BUDGET set. Unset one or pick a tier (${TIER_NAMES.join(", ")}).`,
    );
  }

  if (level === null && budget === null) {
    // The "both unset" branch picks a sane per-model default. Adaptive
    // models (Opus 4.7+) default to medium-effort thinking because the
    // operator picked Opus when they didn't override, and the rotation
    // proposal's analytics value lives in trace richness — running a
    // thinking-capable model with thinking off would waste the run.
    // Budget-style models stay at none-by-default to preserve their
    // cheap nightly baseline for ad-hoc Sonnet-via-override runs.
    if (THINKING_STYLE === "adaptive") {
      return { level: "medium", budgetTokens: TIER_BUDGET_TOKENS.medium };
    }
    return { level: "none" };
  }
  if (level === null) return { level: "custom", budgetTokens: budget! };
  if (level === "none") return { level: "none" };
  return { level, budgetTokens: budget ?? TIER_BUDGET_TOKENS[level] };
}

export const REASONING: ReasoningConfig = resolveReasoning();

/** Per-million-token pricing block — four buckets matching what the
 *  Anthropic SDK's usage reports (uncached input, 5-min cache write,
 *  cache read, output).
 *
 *  We bill at 5-min cache-write rates because the harness uses
 *  `cache_control: { type: "ephemeral" }` markers, which Anthropic
 *  documents as 1.25× base input — see `evals/harness/runner.ts` cache
 *  control comment. If we ever switch to 1-hour TTL (2× base input),
 *  the catalog needs a second column. Not today.
 *
 *  Cache buckets are optional because non-Anthropic vendors (LM Studio,
 *  OpenAI in many shapes) don't expose them; their rows omit those
 *  fields and `estimateCostUsd` treats missing buckets as zero. `tiers`
 *  is a forward-looking hook for OpenAI batch / Vertex context-length
 *  tiered pricing — see #50/#51. */
export interface PricingPerMTok {
  /** $/MTok uncached input. */
  input: number;
  /** $/MTok cache_creation_input_tokens (5-min TTL = 1.25× input).
   *  Anthropic-only; omit on vendors without prompt caching. */
  inputCacheWrite?: number;
  /** $/MTok cache_read_input_tokens (= 0.1× input).
   *  Anthropic-only; omit on vendors without prompt caching. */
  inputCacheRead?: number;
  /** $/MTok output. */
  output: number;
  /** Optional tiered pricing — future hook for Vertex context-length
   *  pricing (#51's bucket-ladder shape). When present,
   *  `estimateCostUsd` currently throws "not yet implemented";
   *  distinct from `longContext*` below, which uses OpenAI's whole-
   *  session-rate-swap shape. */
  tiers?: Array<{ upTo: number; pricePerMTok: number }>;
  /** OpenAI long-context tier: input prompt above this many tokens
   *  switches the WHOLE request to the long-context rates (NOT a
   *  per-bucket ladder — fundamentally different from `tiers`). GPT-5.5
   *  threshold is 272K input tokens. When undefined, `estimateCostUsd`
   *  uses the standard `input`/`output`/`inputCacheRead` rates
   *  unconditionally. */
  longContextThresholdTokens?: number;
  /** $/MTok input under the long-context tier. Required if
   *  `longContextThresholdTokens` is set. */
  longContextInput?: number;
  /** $/MTok output under the long-context tier. Required if
   *  `longContextThresholdTokens` is set. */
  longContextOutput?: number;
  /** $/MTok cache-read under the long-context tier. When undefined,
   *  `estimateCostUsd` falls back to `inputCacheRead` (the short-
   *  context cache rate) — conservative; over-bills slightly relative
   *  to "cached rate scales with fresh rate" if OpenAI's actual
   *  long-context cached rate is higher than the short-context one. */
  longContextInputCacheRead?: number;
}

/** Anthropic catalog rows always populate the two cache buckets — the
 *  rate card has them and the harness uses `cache_control: ephemeral`
 *  on every trial. Pin this at the type level so the catalog forces
 *  cache buckets on every Anthropic row at construction (vs only
 *  catching the omission via the runtime cache-multiplier test) and
 *  `PRICING_PER_MTOK` doesn't need a cast. */
type AnthropicPricingRow = PricingPerMTok & {
  inputCacheWrite: number;
  inputCacheRead: number;
};

/** Shape of the pricing catalog. The Anthropic sub-map is constrained
 *  to the `SupportedModel` keyset — adding a new entry to
 *  `SUPPORTED_MODELS` forces TypeScript to flag the missing pricing row
 *  here, restoring the compile-time guarantee the pre-#48 flat catalog
 *  had. Other vendors carry their own model namespaces (free-form string
 *  keys) and may register the wildcard `"*"` sentinel to opt every
 *  model under them into a shared row (LM Studio's zero-pricing). */
interface PricingCatalog {
  anthropic: Record<SupportedModel, AnthropicPricingRow>;
  openai: Record<string, PricingPerMTok>;
  vertex: Record<string, PricingPerMTok>;
  "lm-studio": Record<string, PricingPerMTok>;
}

/** Per-vendor pricing catalog.
 *
 *  Vendor sub-maps may be empty until their adapter PR lands (#50 for
 *  OpenAI, #51 for Vertex). Looking up an unknown (vendor, model) pair
 *  via `pricingFor` throws rather than silently falling back to
 *  Anthropic rates — see issue #48.
 *
 *  Anthropic source: <https://platform.claude.com/docs/en/about-claude/pricing>
 *  (fetched 2026-05-16). Update the date + verify when bumping rates.
 *
 *  Adding an Anthropic model: add the public model id to
 *  `SUPPORTED_MODELS`, then a pricing row under the `anthropic` sub-map
 *  here. TypeScript will flag any missing pair via the `Record<
 *  SupportedModel, AnthropicPricingRow>` constraint on the sub-map.
 *
 *  Note on Opus 4.7: uses a new tokenizer vs prior models — may consume
 *  up to ~35% more tokens for the same fixed text per the rate card. */
export const PRICING_CATALOG: PricingCatalog = {
  anthropic: {
    "claude-sonnet-4-6": {
      input: 3.0,
      inputCacheWrite: 3.75,
      inputCacheRead: 0.3,
      output: 15.0,
    },
    "claude-opus-4-7": {
      input: 5.0,
      inputCacheWrite: 6.25,
      inputCacheRead: 0.5,
      output: 25.0,
    },
  },
  openai: {
    // GPT-5.5 standard pricing. Source: OpenAI Pricing page
    // (https://openai.com/api/pricing/) + GPT-5.5 model card
    // (https://developers.openai.com/api/docs/models/gpt-5.5),
    // retrieved 2026-05-18. Cached input is OpenAI's 90%-discounted
    // rate (10% of the fresh-input rate) — co-opts the existing
    // `inputCacheRead` bucket; `estimateCostUsd` for vendor==openai
    // adjusts `inputTokens` to exclude the cached portion before
    // billing, because OpenAI's `prompt_tokens` includes cached tokens
    // (Anthropic's does not). `inputCacheWrite` stays undefined —
    // OpenAI does not bill cache writes. Batch / Flex / Priority
    // pricing modes are NOT modeled here; the harness uses standard
    // pricing.
    //
    // Long-context tier (PR #60 review, gpt-5 #4 + re-review): prompts
    // above 272K input tokens are billed at 2× input + 1.5× output for
    // the WHOLE request — $10/Mtok input + $45/Mtok output. The first
    // post-review pass had this at $8/$36 from a stale web-search
    // summary; gpt-5 re-review caught it against the developers.openai
    // .com/api/docs/models/gpt-5.5 doc + openai.com/api/pricing/.
    //
    // Long-context cached rate: assumed to be 2× the short-context
    // cache rate (matching the input-multiplier convention) → $1/Mtok.
    // OpenAI does not document the long-context cache rate explicitly;
    // pin it here with a clear assumption rather than fall back to the
    // short-context $0.50, which would under-bill (gpt-5 re-review
    // caught the original comment incorrectly calling $0.50 a
    // conservative over-bill — it isn't).
    "gpt-5.5": {
      input: 5.0,
      inputCacheRead: 0.5,
      output: 30.0,
      longContextThresholdTokens: 272_000,
      longContextInput: 10.0,
      longContextOutput: 45.0,
      longContextInputCacheRead: 1.0,
    },
  },
  vertex: {
    // Gemini 3.1 Pro Preview standard pricing. Source:
    // https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
    // (fetched 2026-05-18, re-verified during Codex PR #62 review —
    // an earlier draft of this row had `longContextOutput` undefined
    // based on a stale page summary that mis-reported output as flat;
    // the live page actually tiers output too, see below). Gemini 3.x
    // prices like GPT-5.5 in that the input + cache rates double when
    // prompt_tokens crosses a context-length boundary (200K here, vs
    // 272K for GPT-5.5). We reuse the existing `longContext*` fields
    // rather than the `tiers` bucket-ladder — Gemini's pricing page
    // documents this as a whole-request rate swap at the 200K
    // boundary, matching OpenAI's semantics exactly (not a per-bucket
    // ladder).
    //
    // The Vertex pricing-page footnote states: "If a query input
    // context is longer than 200K tokens, all tokens (input and
    // output) are charged at long context rates." So when input
    // crosses the threshold, output bills at the long-context rate
    // too ($18/Mtok = 1.5× the $12 base, matching the GPT-5.5
    // output multiplier of 1.5× by coincidence).
    //
    // PREVIEW NOTE: `gemini-3.1-pro-preview` is a preview id; Google
    // documents that preview pricing can change before GA. Operator
    // MUST re-verify against the Vertex pricing page before any large
    // real-money run; revise this row when rates move. The row exists
    // for cost-math correctness on the #51 paid smoke and on the
    // rotation work (#52); it is not a long-lived guarantee.
    //
    // What this row INTENTIONALLY does NOT model: `cachedContents`
    // storage cost. Vertex bills cached-content storage separately
    // from cached-token reads — a small per-Mtok-per-hour rate
    // amortized over the cache's TTL. With cdp-mcp's 30-min TTL,
    // ~5K-token prefix, and per-trial cache lifetime, this is a
    // rounding error (≤ $0.0001/trial at published rates) and lives
    // below the cost-math precision the harness reports. Revisit if
    // a future scenario stretches trial runtime above 30 min, or if
    // Google raises storage rates materially.
    //
    // Also: Vertex's `usageMetadata.cachedContentTokenCount` is
    // surfaced under the vendor-native key `cachedContentTokens` on
    // `NormalizedMessage.usage.cacheTokens` — `estimateCostUsd`'s
    // vertex branch keys on that name. Since Gemini's
    // `promptTokenCount` INCLUDES cached tokens (same as OpenAI's
    // `prompt_tokens` and unlike Anthropic's `input_tokens`), the
    // vertex billing branch subtracts cached from input before billing
    // the fresh-input bucket; the cached portion is billed at the
    // cache-read rate. See switch case in `estimateCostUsd` below.
    "gemini-3.1-pro-preview": {
      input: 2.0,
      inputCacheRead: 0.20,
      output: 12.0,
      longContextThresholdTokens: 200_000,
      longContextInput: 4.0,
      longContextInputCacheRead: 0.40,
      longContextOutput: 18.0,
    },
  },
  "lm-studio": {
    // Wildcard sentinel — every model under lm-studio is free; cost
    // math short-circuits on this vendor regardless of model id.
    "*": { input: 0, output: 0 },
  },
};

/** Resolve a pricing row for a (vendor, model) pair. Lookup order:
 *  1. Exact match: `PRICING_CATALOG[vendor][model]`.
 *  2. Wildcard fallback: `PRICING_CATALOG[vendor]["*"]` (LM Studio).
 *  3. Throw — never silently default to Anthropic rates on a miss.
 *
 *  This is the post-#48 replacement for indexing the catalog directly.
 *  Anthropic-internal callers can still read
 *  `PRICING_CATALOG.anthropic[id]`; everything else should go through
 *  this helper so unsupported pairs fail loudly. */
export function pricingFor(vendor: Vendor, model: string): PricingPerMTok {
  // Widen the per-vendor sub-map to the common `Record<string,
  // PricingPerMTok>` shape for read-only lookup. The Anthropic
  // sub-map's stricter type (`Record<SupportedModel,
  // AnthropicPricingRow>`) is preserved at construction; this cast
  // only affects the lookup site, where the function's return type is
  // already the generic `PricingPerMTok` superset anyway.
  const vendorMap = PRICING_CATALOG[vendor] as Record<string, PricingPerMTok>;
  const exact = vendorMap[model];
  if (exact !== undefined) return exact;
  const wildcard = vendorMap["*"];
  if (wildcard !== undefined) return wildcard;
  throw new Error(
    `No pricing row for (${vendor}, ${model}). Add it to PRICING_CATALOG.${vendor} or register a "*" sentinel.`,
  );
}

/** Pricing for the active (Anthropic) model — resolved at module load
 *  via MODEL_ID. Type-level safe (no cast) because
 *  `PricingCatalog.anthropic` is `Record<SupportedModel, …>` and
 *  `MODEL_ID: SupportedModel` — the entry is required to exist by the
 *  catalog construction. The `!` only suppresses
 *  `noUncheckedIndexedAccess` (which conservatively widens every index
 *  access). Exported name preserved for backwards compatibility with
 *  consumers (`model.test.ts`). */
export const PRICING_PER_MTOK: AnthropicPricingRow =
  PRICING_CATALOG.anthropic[MODEL_ID]!;

/** Estimate the USD cost of a run from token counts.
 *
 *  The Anthropic SDK reports the four buckets as disjoint: `input_tokens`
 *  is uncached input only; `cache_creation_input_tokens` and
 *  `cache_read_input_tokens` are tracked separately. Bill each at its
 *  own rate — do NOT subtract cache_read from input (that double-counts
 *  the discount and produces negative costs on cache-heavy runs). See
 *  issue #16 for the regression this replaced.
 *
 *  Post-#48 this takes `(vendor, model)` explicitly and routes through
 *  `pricingFor`; vendors without cache buckets (LM Studio sentinel)
 *  contribute zero from those terms.
 *
 *  Post-#50 this consumes the vendor-tagged `cacheTokens` map directly
 *  (the same shape `NormalizedMessage.usage.cacheTokens` and the trace's
 *  `UsageEntry.cacheTokens` carry). Each vendor's known cache-key names
 *  are dispatched onto the catalog's pricing buckets:
 *    - Anthropic:  cacheCreationInputTokens → inputCacheWrite,
 *                  cacheReadInputTokens     → inputCacheRead.
 *    - OpenAI:     cachedTokens → inputCacheRead, and because OpenAI's
 *                  `prompt_tokens` already INCLUDES cached tokens, the
 *                  fresh-input bill is `(inputTokens - cachedTokens) ×
 *                  row.input` rather than `inputTokens × row.input`.
 *                  (Anthropic's input_tokens excludes cache, so no
 *                  subtraction there.)
 *    - Vertex / LM Studio: no cache buckets today.
 *  This replaces the pre-#50 per-bucket-arg signature (where the runner
 *  destructured `totalCacheTokens` into `cacheCreationInputTokens` +
 *  `cacheReadInputTokens` named args), which hard-coded Anthropic key
 *  names at the cost call site. */
export function estimateCostUsd(
  vendor: Vendor,
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens?: Record<string, number>;
  },
): number {
  const row = pricingFor(vendor, model);
  if (row.tiers !== undefined) {
    // The `tiers` bucket-ladder shape is still unwired. Both OpenAI
    // (GPT-5.5, #50) and Vertex (Gemini 3.1 Pro Preview, #51) ended up
    // using the whole-request-rate-swap shape (`longContextThreshold-
    // Tokens` + `longContext*`) instead, which is what each vendor's
    // pricing page actually documents. The bucket-ladder remains a
    // forward-looking hook for any future vendor that bills per-
    // bucket; if/when one shows up, wire tier resolution here.
    throw new Error("tiered pricing not yet implemented (the bucket-ladder shape has no current consumer; both OpenAI and Vertex use longContext* whole-request swap instead)");
  }
  const cacheTokens = tokens.cacheTokens ?? {};
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let inputTokensForBilling = tokens.inputTokens;

  switch (vendor) {
    case "anthropic":
      cacheWriteTokens = cacheTokens.cacheCreationInputTokens ?? 0;
      cacheReadTokens = cacheTokens.cacheReadInputTokens ?? 0;
      break;
    case "openai": {
      const cached = cacheTokens.cachedTokens ?? 0;
      cacheReadTokens = cached;
      // OpenAI's `prompt_tokens` is documented as INCLUDING cached
      // tokens (cf. `prompt_tokens_details.cached_tokens`). Subtract so
      // the fresh-input bucket is billed only on the un-cached portion;
      // the cached portion is billed at inputCacheRead. Clamp at zero
      // defensively for any usage report where cached > prompt_tokens
      // (shouldn't happen, but a single bad response shouldn't produce
      // a negative cost).
      inputTokensForBilling = Math.max(0, tokens.inputTokens - cached);
      break;
    }
    case "vertex": {
      // Gemini's explicit `cachedContents` API populates
      // `usageMetadata.cachedContentTokenCount` — the Vertex adapter
      // surfaces this under the vendor-native key `cachedContentTokens`.
      // Same shape as OpenAI: `promptTokenCount` INCLUDES the cached
      // portion, so subtract before billing the fresh-input bucket.
      const cached = cacheTokens.cachedContentTokens ?? 0;
      cacheReadTokens = cached;
      inputTokensForBilling = Math.max(0, tokens.inputTokens - cached);
      break;
    }
    case "lm-studio":
      // No cache buckets — local runs have no cache layer.
      break;
  }

  // OpenAI long-context tier (PR #60 review, gpt-5 #4): if the row has
  // a long-context threshold AND the prompt crossed it, swap to the
  // long-context rates for input/output (and optionally cache-read).
  // This is a totals-based approximation: OpenAI actually bills per-
  // request, and a session that crossed the threshold in some
  // iterations but not others would need per-iter billing for full
  // precision. The per-iter trip is surfaced to stderr by the OpenAI
  // adapter so the operator can spot it; precise per-iter billing is
  // a follow-up alongside the variance-characterization work in #59.
  let inputRate = row.input;
  let outputRate = row.output;
  let cacheReadRate = row.inputCacheRead ?? 0;
  if (
    row.longContextThresholdTokens !== undefined &&
    tokens.inputTokens > row.longContextThresholdTokens
  ) {
    inputRate = row.longContextInput ?? row.input;
    outputRate = row.longContextOutput ?? row.output;
    cacheReadRate = row.longContextInputCacheRead ?? row.inputCacheRead ?? 0;
  }

  return (
    (inputTokensForBilling / 1_000_000) * inputRate +
    (cacheWriteTokens / 1_000_000) * (row.inputCacheWrite ?? 0) +
    (cacheReadTokens / 1_000_000) * cacheReadRate +
    (tokens.outputTokens / 1_000_000) * outputRate
  );
}

/** The harness's hard ceiling on tool-use iterations per trial. Prevents
 *  pathological loops where the agent keeps retrying the same tool. The
 *  oracle's `efficiency` score is the per-trial signal; this is the
 *  safety net. */
export const MAX_ITERATIONS_PER_TRIAL = 30;

/** Baseline per-trial output-token cap. Approximation of the cost-table
 *  assumption (~22K output tokens/trial); set generously so reasonable
 *  non-thinking trials don't bump into it but pathological loops do.
 *
 *  **When extended thinking is enabled** (`REASONING.level !== "none"`),
 *  the runner scales the effective cap up to
 *  `(budget_tokens + response-headroom) × MAX_ITERATIONS_PER_TRIAL`,
 *  because Anthropic counts thinking inside `output_tokens` and the
 *  baseline 64K would halt every thinking trial after ~4 iterations. At
 *  16K thinking + 30 iter ceiling that's a ~600K cap, ~10× baseline
 *  (worst-case ~$9/trial at Sonnet 4.6 output rates).
 *
 *  The real backstop in either regime is `EVAL_BUDGET_USD` — the per-
 *  trial cap is the pathological-loop guard, not the cost ceiling. */
export const MAX_OUTPUT_TOKENS_PER_TRIAL = 64_000;

/** Hard USD ceiling on a single `npm run eval` invocation. The harness
 *  tracks running cost as trials complete and exits early (mid-trial if
 *  necessary) once spend > BUDGET. Operator-chosen for the first real
 *  run; well above empirical full-suite cost (Sonnet 4.6 came in at
 *  ~$5–10/nightly; Opus-4.7-medium first observation was ~$4 — one
 *  data point, not a steady-state band), so it only fires on a
 *  genuine surprise (model
 *  deprecation forcing a costlier fallback, cache_control wiring
 *  regression, etc.).
 *
 *  Override via EVAL_BUDGET_USD env at invocation time. */
export const DEFAULT_BUDGET_USD = 100;

export function readBudgetUsd(): number {
  const env = process.env.EVAL_BUDGET_USD;
  if (!env) return DEFAULT_BUDGET_USD;
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `EVAL_BUDGET_USD must be a positive number, got '${env}'. Unset to use the default ($${DEFAULT_BUDGET_USD}).`,
    );
  }
  return n;
}
