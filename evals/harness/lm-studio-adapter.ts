// LM Studio vendor adapter — OpenAI-compatible Chat Completions.
//
// Born as the issue #45 investigation artifact (multi-backend eval-harness
// spike). Its inline transport was extracted into `openai-compat.ts` (#50)
// and then generalized into the shared `makeOpenAICompatAdapter` factory
// (GH #8), which DeepSeek and Moonshot adopted first; GH #7 closed the loop
// and this file is now a thin config wrapper over that same factory, like
// `deepseek-adapter.ts` / `moonshot-adapter.ts`.
//
// LM-Studio-specific choices:
//   - No `defaultBaseUrl` — EVAL_LM_STUDIO_BASE_URL is REQUIRED. The server
//     lives wherever the operator runs it; a silent localhost fallback would
//     mask a misconfigured run.
//   - `defaultMaxTokens: 4096` — parity with this adapter's historical
//     default (the no-thinking branch of the Anthropic adapter). Local runs
//     don't bill, but an over-large cap lets a runaway turn generate for
//     minutes on local hardware; buy headroom explicitly via
//     EVAL_LM_STUDIO_MAX_TOKENS (GH #7).
//   - No `cacheTokensFrom` — LM Studio has no prompt caching and reports no
//     cached tokens; `usage.cacheTokens` stays undefined (correct trace shape
//     for "no cache activity"; runner reads absent as 0). Cost math
//     short-circuits on the `"*"` $0 pricing wildcard.
//   - `req.thinking` is dropped (the factory maps no thinking TIER). Models
//     that reason do so opaquely — there is no `signature` to round-trip.
//     Request MORE analysis via EVAL_LM_STUDIO_REASONING_EFFORT instead:
//     reasoning models like gpt-oss run at LM Studio's LOW default effort
//     unless told otherwise (see draft PR #28's A/B notes before expecting
//     score movement from it).
//
// Env vars consumed:
//   EVAL_PROVIDER                   — must be "lm-studio" for cli.ts to pick
//                                     this adapter at all.
//   EVAL_LM_STUDIO_BASE_URL         — full base URL including /v1, e.g.
//                                     "http://localhost:1234/v1". Required.
//   EVAL_LM_STUDIO_MODEL            — LM Studio model id, e.g.
//                                     "openai/gpt-oss-120b". Required.
//   EVAL_LM_STUDIO_API_KEY          — Bearer token. Required.
//   EVAL_LM_STUDIO_MAX_TOKENS       — optional per-run output-cap override
//                                     (positive integer, GH #7).
//   EVAL_LM_STUDIO_REASONING_EFFORT — optional low|medium|high|xhigh|max
//                                     (GH #7, extracted from draft PR #28).

import { makeOpenAICompatAdapter } from "./openai-compat-adapter.js";
import type { VendorAdapter } from "./vendor.js";

export function makeLmStudioAdapter(): VendorAdapter {
  return makeOpenAICompatAdapter({
    vendor: "lm-studio",
    label: "LM Studio",
    apiKeyEnv: "EVAL_LM_STUDIO_API_KEY",
    modelEnv: "EVAL_LM_STUDIO_MODEL",
    baseUrlEnv: "EVAL_LM_STUDIO_BASE_URL",
    // No defaultBaseUrl / no cacheTokensFrom — see the header for both.
    defaultMaxTokens: 4096,
    maxTokensEnv: "EVAL_LM_STUDIO_MAX_TOKENS",
    reasoningEffortEnv: "EVAL_LM_STUDIO_REASONING_EFFORT",
  });
}
