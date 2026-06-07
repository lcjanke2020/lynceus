// DeepSeek vendor adapter (LEO-233) — OpenAI-compatible Chat Completions.
//
// Thin wrapper over the shared `makeOpenAICompatAdapter` factory; see
// `openai-compat-adapter.ts` for the transport and the v1 scope notes
// (max_tokens, no Responses API, no cache accounting).

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
  });
}
