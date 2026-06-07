// Shared OpenAI-compatible Chat Completions adapter factory (LEO-233).
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
// mapped to a vendor knob. DeepSeek runs reasoning-off; Moonshot's Kimi K2
// Thinking runs with its DEFAULT thinking on, and Moonshot's `reasoning_content`
// is captured + round-tripped by the shared openai-compat translators (required
// — K2 hard-rejects a tool-call turn that omits it; LEO-233). Sends `max_tokens`
// (NOT `max_completion_tokens`). Caching is not accounted in v1: the adapter
// leaves `NormalizedMessage.usage.cacheTokens` undefined, so `estimateCostUsd`
// bills input + output only (the cache term is zero). Per-vendor cache-key
// extraction is the v2 follow-up (LEO-233 §3).

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
}

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
  // construction-time error (LEO-233 review). Row intentionally discarded.
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
        // OpenAI Chat Completions adapter sends.
        max_tokens: req.maxTokens ?? 4096,
      };
      // The harness thinking TIER (req.thinking) is dropped — no Responses API
      // and no vendor tier knob. Moonshot's reasoning_content is captured +
      // round-tripped by the shared translators (translateResponse /
      // translateMessages), not here.

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
          // cacheTokensFrom omitted in v1 — no cache accounting (see header):
          // the shared translator leaves cacheTokens undefined.
          return translateResponse(oResp, cfg.vendor);
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
