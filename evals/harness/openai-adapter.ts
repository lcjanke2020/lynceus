// OpenAI VendorAdapter — issue #50.
//
// Production adapter for the OpenAI Chat Completions API. Lands the
// third backend (alongside Anthropic and the LM Studio investigation
// artifact) and unblocks the cross-family comparison PR #44 surfaced —
// does GPT-5.5 follow the SDET workflow rigidly, or does the lazy-solver
// pattern reproduce on a non-Anthropic model?
//
// Design: direct `fetch` against `/v1/chat/completions` rather than the
// `openai` npm SDK. LM Studio's investigation artifact already proved the wire shape
// works; adding the SDK would buy nothing the runner uses today
// (streaming, Files API, retries) at the cost of an extra dependency
// and version-drift risk.
//
// What's REAL:
//   - Tool-use round-trip via shared `openai-compat.ts` translators.
//   - Usage extraction including `prompt_tokens_details.cached_tokens`
//     surfaced under the vendor-native key `cachedTokens` on
//     `NormalizedMessage.usage.cacheTokens` (see `docs/eval-backends-
//     investigation.md` §OpenAI cache reporting).
//   - Reasoning-effort knob: harness `ThinkingRequest.tier` →
//     OpenAI `reasoning_effort` (low/medium/high). `xhigh`/`max` clamp
//     to `"high"` — OpenAI exposes the three-level enum only.
//   - `max_completion_tokens` (the Responses-era successor to
//     `max_tokens` — required for reasoning models, which 400 on the
//     legacy field).
//   - Custom `EVAL_OPENAI_BASE_URL` for Azure OpenAI or a corporate
//     gateway — defaults to `https://api.openai.com/v1`.
//
// What's STUBBED (and why):
//   - Reasoning-summary text capture: the Chat Completions API does not
//     return round-trippable reasoning text alongside `reasoning_effort`,
//     so the `NormalizedThinkingBlock` openai variant added in #50 is
//     never populated by this adapter. A future Responses-API path can
//     fill it in; the type slot exists so that path doesn't need a union
//     reshape.
//   - `temperature` is dropped when `thinking` is requested (GPT-5.5 and
//     o-series reject non-default temperature on reasoning requests —
//     mirrors the Anthropic adapter's Opus-4.7 handling).
//
// Env vars consumed:
//   EVAL_PROVIDER             — must be "openai" for cli.ts to pick this
//                               adapter at all.
//   OPENAI_API_KEY            — bearer token. Required. (Standard OpenAI
//                               SDK env convention; intentionally NOT
//                               `EVAL_OPENAI_API_KEY` so existing OpenAI
//                               tooling can share the env.)
//   EVAL_OPENAI_MODEL         — model id, e.g. "gpt-5.5". Required.
//   EVAL_OPENAI_BASE_URL      — optional override; defaults to
//                               "https://api.openai.com/v1".

import {
  mapFinishReason as _mapFinishReason,
  translateMessages,
  translateResponse,
  translateTools,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from "./openai-compat.js";
import type {
  NormalizedMessage,
  ReasoningTier,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { withRetry } from "./with-retry.js";

// Re-export the helper so adapter consumers don't have to know whether
// it's defined here or in the shared module. (Tests reach for it through
// this module to make the test file's import surface symmetric with
// `anthropic.ts`.)
export { _mapFinishReason as mapFinishReason };

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** GPT-5.5's `reasoning_effort` enum: `low | medium | high | xhigh`
 *  (per <https://platform.openai.com/docs/guides/latest-model> and the
 *  OpenAI dev community compatibility matrix). The harness's tier
 *  vocabulary maps directly onto the first four — only `max` has no
 *  GPT-5.5 equivalent and clamps to `xhigh`.
 *
 *  PR #60 review caught the pre-fix shape (clamp `xhigh` and `max` both
 *  to `high`) — that would silently drop the top tier the rotation
 *  vocabulary is trying to preserve.
 *
 *  Distinct from `model.ts:tierToEffort` (which targets Anthropic's
 *  five-level adaptive enum). Kept module-local on purpose; the
 *  Anthropic mapping is a different vocabulary and the two should stay
 *  separate. */
export function tierToOpenaiEffort(
  tier: ReasoningTier,
): "low" | "medium" | "high" | "xhigh" {
  switch (tier) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "xhigh";
  }
}

/** Per-tier approximation for `max_completion_tokens` when the caller
 *  doesn't supply `req.maxTokens`. The cap must cover hidden reasoning
 *  tokens + the visible answer combined on reasoning models, so it
 *  scales with the requested effort. Mirrors Anthropic's
 *  `ADAPTIVE_TIER_MAXTOKENS_APPROX` shape (deliberately the same
 *  numbers — the operator's mental model is "this effort tier gets
 *  this much room to think").
 *
 *  PR #60 review (Claude + gpt-5 rollups) flagged that the previous
 *  fixed `?? 4096` default would truncate reasoning trials at the
 *  first iter with `finish_reason=length`. This makes the default
 *  scale with the requested effort. */
const OPENAI_TIER_MAXTOKENS_APPROX: Record<
  "low" | "medium" | "high" | "xhigh",
  number
> = {
  low: 8192,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
};

/** Visible-response headroom for non-thinking requests + thinking
 *  trials. 4096 matches Anthropic's `RESPONSE_HEADROOM_TOKENS`. */
const RESPONSE_HEADROOM_TOKENS = 4096;

/** Long-context threshold for GPT-5.5: prompts above this many input
 *  tokens are billed at the long-context rates for the WHOLE request
 *  (per <https://openai.com/api/pricing/> and OpenAI's GPT-5.5 model
 *  card). Used here only for the per-iteration warning; cost math
 *  applies the threshold in `model.ts:estimateCostUsd`. */
const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/** Pull OpenAI's cached-token count out of the usage block and surface
 *  it under the vendor-native key `cachedTokens` — matches the OpenAI
 *  field name (`usage.prompt_tokens_details.cached_tokens`) and is what
 *  `estimateCostUsd` keys on for the OpenAI billing path. Returns
 *  `undefined` when the field is absent so the shared translator omits
 *  `cacheTokens` from the response (the runner reads absent as zero). */
function openaiCacheTokensFrom(
  usage: OpenAIChatResponse["usage"],
): Record<string, number> | undefined {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  if (cached === undefined || cached === null) return undefined;
  return { cachedTokens: cached };
}

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The OpenAI adapter requires OPENAI_API_KEY and EVAL_OPENAI_MODEL (EVAL_OPENAI_BASE_URL optional). See evals/harness/openai-adapter.ts header.`,
    );
  }
  return v;
}

/** Build the Chat Completions request body. Exported for the adapter
 *  test so it can pin request shape without spinning up `fetch`. */
export function buildOpenaiRequest(
  model: string,
  req: VendorMessageRequest,
): OpenAIChatRequest {
  const thinkingEnabled = req.thinking !== undefined;
  const effort = thinkingEnabled ? tierToOpenaiEffort(req.thinking!.tier) : undefined;

  // Size max_completion_tokens to cover hidden reasoning + visible
  // response. On reasoning models a fixed-low cap would truncate at
  // the first iter (PR #60 review). When thinking is on, use the
  // per-tier approximation + headroom; when thinking is off, the
  // visible response headroom is enough.
  const maxCompletionTokens =
    req.maxTokens ??
    (effort !== undefined
      ? OPENAI_TIER_MAXTOKENS_APPROX[effort] + RESPONSE_HEADROOM_TOKENS
      : RESPONSE_HEADROOM_TOKENS);

  // OpenAI reasoning models (GPT-5.x, o-series) reject non-default
  // temperature on reasoning-effort requests. Drop the field on the
  // thinking-on path; honor caller-supplied temperature otherwise.
  // Same shape as the Anthropic adapter's Opus-4.7 handling.
  const temperature = thinkingEnabled ? undefined : req.temperature;

  const out: OpenAIChatRequest = {
    model,
    messages: translateMessages(req.system, req.messages),
    ...(req.tools && req.tools.length > 0
      ? { tools: translateTools(req.tools), tool_choice: "auto" }
      : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    max_completion_tokens: maxCompletionTokens,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
  return out;
}

export interface MakeOpenaiAdapterOpts {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function makeOpenaiAdapter(opts: MakeOpenaiAdapterOpts = {}): VendorAdapter {
  const apiKey = opts.apiKey ?? readEnv("OPENAI_API_KEY");
  const model = opts.model ?? readEnv("EVAL_OPENAI_MODEL");
  // `||` (not `??`) so that an empty-string env var falls through to
  // the default. PR #60 review nit — `??` would let
  // `EVAL_OPENAI_BASE_URL=""` produce a malformed URL on fetch.
  const baseUrl = (
    opts.baseUrl ||
    process.env.EVAL_OPENAI_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  return {
    vendor: "openai",
    model,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      const oReq = buildOpenaiRequest(model, req);
      const url = `${baseUrl}/chat/completions`;

      // #63: wrap the fetch + status check + parse so transient network
      // errors (TypeError fetch failed, ECONNRESET, 429, 5xx) get
      // retried with exponential backoff. Per-attempt AbortController
      // timeout stays as the inner ceiling; `withRetry`'s `timeoutMs`
      // is the outer budget across attempts.
      return withRetry(
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            req.timeoutMs ?? 5 * 60 * 1000,
          );
          let resp: Response;
          try {
            resp = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(oReq),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            // #63 review (PR #65, Codex/GPT-5 #1): attach status and
            // Retry-After to the thrown error so `withRetry`'s
            // classifier can honor real 429 cooldowns instead of
            // jittered exponential backoff. The Response headers object
            // is gone the moment we throw a plain Error, so capture
            // what the classifier needs up-front.
            throw Object.assign(
              new Error(
                `OpenAI request failed: ${resp.status} ${resp.statusText} — ${body.slice(0, 500)}`,
              ),
              {
                status: resp.status,
                headers: { "retry-after": resp.headers.get("retry-after") ?? undefined },
              },
            );
          }
          const oResp = (await resp.json()) as OpenAIChatResponse;
          const normalized = translateResponse(oResp, "openai", openaiCacheTokensFrom);

          // Long-context tier warning (PR #60 review, gpt-5 #4): GPT-5.5
          // bills the WHOLE request at long-context rates ($8/$36 vs.
          // $5/$30 per Mtok) when `prompt_tokens > 272_000`. The trace
          // sums per-iter token counts; cost math applies the threshold
          // in `model.ts:estimateCostUsd` based on totals, which is a
          // coarse approximation. Surface the per-iter trip here so the
          // operator can see when long-context billing kicks in even when
          // cumulative totals are still below threshold.
          if (normalized.usage.inputTokens > OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS) {
            process.stderr.write(
              `[openai-adapter] WARN: prompt_tokens=${normalized.usage.inputTokens} > ${OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS} (GPT-5.5 long-context threshold). This request is billed at long-context rates ($10/Mtok input, $45/Mtok output).\n`,
            );
          }

          return normalized;
        },
        {
          vendor: "openai",
          timeoutMs: req.timeoutMs,
          onRetry: req.onRetry,
        },
      );
    },
  };
}
