// Moonshot (Kimi) vendor adapter (GH #8) — OpenAI-compatible Chat Completions.
//
// Thin wrapper over the shared `makeOpenAICompatAdapter` factory; see
// `openai-compat-adapter.ts` for the transport and the v1 scope notes.
//
// NOTE: this is Moonshot's OpenAI-compatible `/v1` endpoint, used by the eval
// harness — distinct from the Kimi *Claude Code* setup, which points at
// Moonshot's Anthropic-compatible `/anthropic` endpoint.

import { makeOpenAICompatAdapter } from "./openai-compat-adapter.js";
import type { VendorAdapter } from "./vendor.js";

/** Reads `EVAL_MOONSHOT_API_KEY` + `EVAL_MOONSHOT_MODEL`
 *  (`EVAL_MOONSHOT_BASE_URL` optional; defaults to the global `.ai`
 *  endpoint, not `.cn`). Per-run output cap: `EVAL_MOONSHOT_MAX_TOKENS`
 *  (GH #7). Models: `kimi-k2.6` (latest), `kimi-k2.5`. */
export function makeMoonshotAdapter(): VendorAdapter {
  return makeOpenAICompatAdapter({
    vendor: "moonshot",
    label: "Moonshot",
    apiKeyEnv: "EVAL_MOONSHOT_API_KEY",
    modelEnv: "EVAL_MOONSHOT_MODEL",
    baseUrlEnv: "EVAL_MOONSHOT_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    // No `extraBody`: Kimi K2 Thinking reasons by Moonshot's server-side
    // default — there's no request-side toggle to send. For the same reason
    // there is no `reasoningEffortEnv` here (GH #7 wires it only where the
    // wire format has the knob: DeepSeek, LM Studio). Cache hits come back
    // OpenAI-style under `prompt_tokens_details.cached_tokens` (GH #8).
    maxTokensEnv: "EVAL_MOONSHOT_MAX_TOKENS",
    cacheTokensFrom: (usage) => {
      const hit = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return hit > 0 ? { cachedTokens: hit } : undefined;
    },
  });
}
