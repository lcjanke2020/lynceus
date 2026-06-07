// DeepSeek vendor adapter (LEO-233 / GH #8) — OpenAI-compatible Chat Completions.
//
// Thin wrapper over the shared `makeOpenAICompatAdapter` factory; see
// `openai-compat-adapter.ts` for the transport. DeepSeek-specific bits:
//
//  - Reasoning is turned ON via the nested `thinking` object (NOT the top-level
//    `reasoning_effort` OpenAI uses). Always-on `high` for parity with Kimi's
//    always-on default (GH #8). DeepSeek's `reasoning_content` is captured to
//    the `.thinking` sidecar by the shared translator but, unlike Kimi, MUST
//    NOT be re-emitted on the next turn (DeepSeek 400s if it is present in
//    input). That capture-only asymmetry lives in the translators, gated on the
//    `deepseek` thinking-block tag.
//  - Prompt-cache accounting reads DeepSeek's top-level
//    `prompt_cache_hit_tokens` (Moonshot/OpenAI use the nested
//    `prompt_tokens_details.cached_tokens` instead). `prompt_tokens` includes
//    the cached portion, so `estimateCostUsd` subtracts it before billing the
//    fresh-input bucket.

import { makeOpenAICompatAdapter } from "./openai-compat-adapter.js";
import type { VendorAdapter } from "./vendor.js";

/** Reads `EVAL_DEEPSEEK_API_KEY` + `EVAL_DEEPSEEK_MODEL`
 *  (`EVAL_DEEPSEEK_BASE_URL` optional; defaults to DeepSeek's
 *  OpenAI-compatible endpoint). Use the v4 model ids
 *  (`deepseek-v4-flash` / `deepseek-v4-pro`) — the `deepseek-chat` /
 *  `deepseek-reasoner` aliases deprecate 2026-07-24. */
export function makeDeepseekAdapter(): VendorAdapter {
  return makeOpenAICompatAdapter({
    vendor: "deepseek",
    label: "DeepSeek",
    apiKeyEnv: "EVAL_DEEPSEEK_API_KEY",
    modelEnv: "EVAL_DEEPSEEK_MODEL",
    baseUrlEnv: "EVAL_DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    // Turn reasoning on (GH #8). `high` is DeepSeek's default effort; `low`/
    // `medium` map to `high` and `xhigh` to `max` server-side anyway.
    extraBody: { thinking: { type: "enabled", reasoning_effort: "high" } },
    // DeepSeek reports cache hits via the top-level `prompt_cache_hit_tokens`.
    cacheTokensFrom: (usage) => {
      const hit = usage?.prompt_cache_hit_tokens ?? 0;
      return hit > 0 ? { cachedTokens: hit } : undefined;
    },
  });
}
