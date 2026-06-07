// DeepSeek vendor adapter (LEO-233 / GH #8) — OpenAI-compatible Chat Completions.
//
// Thin wrapper over the shared `makeOpenAICompatAdapter` factory; see
// `openai-compat-adapter.ts` for the transport. DeepSeek-specific bits:
//
//  - Reasoning is turned ON via `thinking: { type: "enabled" }` + top-level
//    `reasoning_effort: "high"` (the documented thinking-mode shape; `high` is
//    also DeepSeek's default, and v4-pro reasons by default regardless).
//  - DeepSeek V4 thinking mode behaves like Kimi K2 — NOT the mirror opposite
//    the old `deepseek-reasoner` guide described. `reasoning_content` is
//    captured to the `.thinking` sidecar AND must be re-emitted on the next
//    tool-call turn; the API rejects a tool-call message that omits it
//    ("reasoning_content ... must be passed back", verified vs the live API,
//    GH #8). That replay lives in the shared translators, gated on moonshot|
//    deepseek thinking-block tags.
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
    // Turn reasoning on (GH #8). Documented thinking-mode shape: `thinking`
    // toggle + top-level `reasoning_effort`. `high` is DeepSeek's default effort
    // (and v4-pro reasons by default), so this is explicit-intent + future
    // disable/tier control rather than strictly required.
    extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    // DeepSeek reports cache hits via the top-level `prompt_cache_hit_tokens`.
    cacheTokensFrom: (usage) => {
      const hit = usage?.prompt_cache_hit_tokens ?? 0;
      return hit > 0 ? { cachedTokens: hit } : undefined;
    },
  });
}
