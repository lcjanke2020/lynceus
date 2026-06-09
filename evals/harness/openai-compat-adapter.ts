// Shared OpenAI-compatible Chat Completions adapter factory (GH #8).
//
// DeepSeek and Moonshot (Kimi) both speak the OpenAI Chat Completions wire
// format — the same shape the LM Studio adapter already drives, but over the
// public internet with a real bill. This factory is the thin transport + env
// wrapper the two share; per-vendor specifics (vendor tag, env-var names,
// default base URL) come in via `OpenAICompatConfig`. The Anthropic-`tool_use`
// <-> OpenAI-`tool_calls` plumbing lives in `openai-compat.ts` and is reused
// verbatim.
//
// Deliberately NOT routed through the OpenAI Responses adapter: neither vendor
// implements `/v1/responses`. The harness's thinking TIER (req.thinking) is not
// mapped to a vendor knob. Both vendors reason: Moonshot's Kimi K2 Thinking runs
// with its DEFAULT thinking on; DeepSeek V4 is turned on per-vendor via
// `cfg.extraBody` (`thinking` enabled + top-level `reasoning_effort` — GH #8).
// Both vendors' `reasoning_content` is captured by the shared openai-compat
// translators AND re-emitted on the next turn — both K2 and DeepSeek V4 reject a
// tool-call message that omits it (DeepSeek V4 behaves like Kimi here, not the
// mirror opposite the old `deepseek-reasoner` guide implied; verified vs the
// live API — GH #8). Sends `max_tokens` (NOT `max_completion_tokens`),
// defaulting to DEFAULT_MAX_OUTPUT_TOKENS so a reasoning turn isn't truncated
// (GH #7). Per-vendor prompt-cache accounting is
// wired via `cfg.cacheTokensFrom` (GH #8): DeepSeek's
// `prompt_cache_hit_tokens` and Moonshot's `prompt_tokens_details.cached_tokens`
// flow into `NormalizedMessage.usage.cacheTokens`, which `estimateCostUsd` bills
// at the cache-read rate.

import {
  translateMessages,
  translateResponse,
  translateTools,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from "./openai-compat.js";
import type {
  NormalizedMessage,
  Vendor,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { withRetry } from "./with-retry.js";
import { pricingFor } from "./model.js";

export interface OpenAICompatConfig {
  /** Vendor tag stamped on traces + consumed by withRetry's classifier. */
  vendor: Vendor;
  /** Human label used in thrown-error messages (e.g. "DeepSeek"). The
   *  `<label> request failed: <status>` shape is what with-retry's
   *  `extractStatus` regex keys on — keep "request failed" in it. */
  label: string;
  /** Env var holding the API key (sent as a Bearer token). */
  apiKeyEnv: string;
  /** Env var holding the model id. */
  modelEnv: string;
  /** Env var that optionally overrides the base URL. Empty string = unset. */
  baseUrlEnv: string;
  /** Base URL (including `/v1`) used when `baseUrlEnv` is unset/empty. */
  defaultBaseUrl: string;
  /** Per-vendor extra request-body fields merged into every Chat Completions
   *  request (GH #8). DeepSeek uses this to enable reasoning (`thinking` toggle
   *  + `reasoning_effort`); Moonshot/LM-Studio leave it unset (Moonshot reasons
   *  by server-side default with no request param).
   *
   *  The core request fields are excluded from the type so a vendor config
   *  CANNOT clobber `model`/`messages`/`tools`/`max_tokens` etc. via `extraBody`
   *  (Copilot + kimi review) — those come from the base build / `req.maxTokens`.
   *  `extraBody` is still merged last, but the type makes the override
   *  impossible at compile time rather than relying on field ordering. */
  extraBody?: Omit<
    Partial<OpenAIChatRequest>,
    "model" | "messages" | "tools" | "tool_choice" | "max_tokens" | "max_completion_tokens"
  >;
  /** Per-vendor cache-token extractor (GH #8). Maps the vendor's native
   *  usage shape to the normalized `cacheTokens` map consumed by
   *  `estimateCostUsd`. DeepSeek reads `prompt_cache_hit_tokens`; Moonshot
   *  reads `prompt_tokens_details.cached_tokens`. Unset = no cache accounting
   *  (cacheTokens stays undefined → input billed at the full fresh rate). */
  cacheTokensFrom?: (
    usage: OpenAIChatResponse["usage"],
  ) => Record<string, number> | undefined;
}

/** Per-request output-token cap default (GH #7). Reasoning-bearing
 *  OpenAI-compat models (DeepSeek V4 thinking, Kimi K2 Thinking) emit
 *  `reasoning_content` + the visible answer inside this single budget; the
 *  previous 4096 truncated them mid-thought (`finish_reason: length`). 32K
 *  covers a deep reasoning turn plus its answer. The runner does not pass a
 *  per-request `maxTokens` (its `tokenCap` is a cumulative cross-iteration
 *  halt), so this default is what actually sizes each call; an explicit
 *  `req.maxTokens` still wins when a caller supplies one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

function requireEnv(name: string, label: string, hint: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. ${label} adapter ${hint}`);
  return v;
}

export function makeOpenAICompatAdapter(cfg: OpenAICompatConfig): VendorAdapter {
  const apiKey = requireEnv(
    cfg.apiKeyEnv,
    cfg.label,
    `requires ${cfg.apiKeyEnv} (API key) and ${cfg.modelEnv} (model id); ${cfg.baseUrlEnv} optional.`,
  );
  const model = requireEnv(
    cfg.modelEnv,
    cfg.label,
    `requires ${cfg.modelEnv} (model id); ${cfg.apiKeyEnv} (API key) also required.`,
  );
  // Treat empty string as unset (mirrors the OpenAI adapter's base-URL handling).
  const baseUrlRaw = process.env[cfg.baseUrlEnv];
  const baseUrl = (
    baseUrlRaw && baseUrlRaw.length > 0 ? baseUrlRaw : cfg.defaultBaseUrl
  ).replace(/\/+$/, "");

  // Pre-flight: fail at construction if there's no pricing row for this
  // (vendor, model). Otherwise pricingFor() wouldn't throw until
  // estimateCostUsd runs in the runner — i.e. AFTER the first billable
  // request. For a paid remote path, turn that post-spend crash into a
  // construction-time error (GH #8 review). Row intentionally discarded.
  pricingFor(cfg.vendor, model);

  return {
    vendor: cfg.vendor,
    model,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      const oReq: OpenAIChatRequest = {
        model,
        messages: translateMessages(req.system, req.messages),
        ...(req.tools && req.tools.length > 0
          ? { tools: translateTools(req.tools), tool_choice: "auto" }
          : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        // DeepSeek/Kimi use `max_tokens`, NOT the `max_completion_tokens` the
        // OpenAI Chat Completions adapter sends. The default must cover hidden
        // reasoning tokens for thinking models (GH #7) — see
        // DEFAULT_MAX_OUTPUT_TOKENS.
        max_tokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        // Per-vendor extras (GH #8): DeepSeek's reasoning toggle.
        // Merged last so it can't be clobbered by the base fields above.
        ...(cfg.extraBody ?? {}),
      };
      // The harness thinking TIER (req.thinking) is NOT mapped to a vendor knob
      // here — no Responses API. Moonshot reasons by server-side default;
      // DeepSeek is turned on via `cfg.extraBody` (thinking enabled + top-level
      // reasoning_effort). Both vendors' `reasoning_content` is captured by the
      // shared translator (translateResponse) AND re-fed on the next tool-call
      // turn (translateMessages) — both APIs reject a tool-call turn that omits
      // it (GH #8).

      const url = `${baseUrl}/chat/completions`;
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
            // Mirrors the OpenAI/LM Studio throw shape so with-retry's
            // status + Retry-After extraction works (see #63).
            throw Object.assign(
              new Error(
                `${cfg.label} request failed: ${resp.status} ${resp.statusText} — ${body.slice(0, 500)}`,
              ),
              {
                status: resp.status,
                headers: {
                  "retry-after": resp.headers.get("retry-after") ?? undefined,
                },
              },
            );
          }
          const oResp = (await resp.json()) as OpenAIChatResponse;
          // Per-vendor cache accounting (GH #8): the extractor maps the
          // vendor's native usage shape into the normalized cacheTokens map.
          // Unset (e.g. lm-studio) → translator leaves cacheTokens undefined.
          return translateResponse(oResp, cfg.vendor, cfg.cacheTokensFrom);
        },
        {
          vendor: cfg.vendor,
          timeoutMs: req.timeoutMs,
          onRetry: req.onRetry,
        },
      );
    },
  };
}
