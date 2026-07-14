// Shared OpenAI-compatible Chat Completions adapter factory (GH #8).
//
// DeepSeek, Moonshot (Kimi), and LM Studio all speak the OpenAI Chat
// Completions wire format. This factory is the thin transport + env wrapper
// the three share; per-vendor specifics (vendor tag, env-var names, default
// base URL, default output cap) come in via `OpenAICompatConfig`. The Anthropic-`tool_use`
// <-> OpenAI-`tool_calls` plumbing lives in `openai-compat.ts` and is reused
// verbatim.
//
// Deliberately NOT routed through the OpenAI Responses adapter: none of these
// vendors implement `/v1/responses`. The harness's thinking TIER (req.thinking)
// is not mapped to a vendor knob. All three reason in their own way: Moonshot's
// Kimi K2 Thinking runs with its DEFAULT thinking on; DeepSeek V4 is turned on
// per-vendor via `cfg.extraBody` (`thinking` enabled + top-level
// `reasoning_effort` — GH #8); LM Studio models reason opaquely at the server's
// default effort unless `reasoningEffortEnv` requests more (GH #7).
// Moonshot's and DeepSeek's `reasoning_content` is captured by the shared
// openai-compat translators AND re-emitted on the next turn — both K2 and
// DeepSeek V4 reject a tool-call message that omits it (DeepSeek V4 behaves like Kimi here, not the
// mirror opposite the old `deepseek-reasoner` guide implied; verified vs the
// live API — GH #8). Sends `max_tokens` (NOT `max_completion_tokens`),
// defaulting to DEFAULT_MAX_OUTPUT_TOKENS so a reasoning turn isn't truncated
// (GH #7); per-vendor env knobs (`maxTokensEnv`, `reasoningEffortEnv` —
// GH #7, extracted from draft PR #28) let a run override the cap and request
// a specific reasoning effort. Per-vendor prompt-cache accounting is
// wired via `cfg.cacheTokensFrom` (GH #8): DeepSeek's
// `prompt_cache_hit_tokens` and Moonshot's `prompt_tokens_details.cached_tokens`
// flow into `NormalizedMessage.usage.cacheTokens`, which `estimateCostUsd` bills
// at the cache-read rate.

import {
  REASONING_EFFORTS,
  translateMessages,
  translateResponse,
  translateTools,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
  type ReasoningEffort,
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
  /** Base URL (including `/v1`) used when `baseUrlEnv` is unset/empty. Omit
   *  to make `baseUrlEnv` REQUIRED instead (LM Studio — the server lives
   *  wherever the operator runs it, and a silent localhost fallback would
   *  mask a misconfigured run). */
  defaultBaseUrl?: string;
  /** Default per-request output cap when neither `req.maxTokens` nor the
   *  `maxTokensEnv` override is set. Unset = DEFAULT_MAX_OUTPUT_TOKENS (32K,
   *  sized for the remote reasoning vendors — GH #7). LM Studio passes 4096:
   *  local runs keep their historical parity default rather than inheriting
   *  the remote headroom (no bill, but an over-large cap lets a runaway turn
   *  generate for minutes on local hardware). */
  defaultMaxTokens?: number;
  /** Env var that overrides the default output cap per run (GH #7, extracted
   *  from draft PR #28). An explicit `req.maxTokens` still wins. Must parse
   *  as a positive integer; unset/empty = knob not engaged (mirrors the
   *  base-URL convention). Validated at construction — before any billable
   *  request. */
  maxTokensEnv?: string;
  /** Env var that forwards the top-level OpenAI-compat `reasoning_effort`
   *  knob, for vendors whose wire format supports it (DeepSeek, LM Studio —
   *  NOT Moonshot, whose thinking has no request-side param). Merged after
   *  `extraBody`, so an operator override beats a vendor config's hardcoded
   *  effort (DeepSeek's `"high"`). Allowed values are the
   *  `OpenAIChatRequest["reasoning_effort"]` union; unset/empty = knob not
   *  engaged. Validated at construction. */
  reasoningEffortEnv?: string;
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
 *  `req.maxTokens` still wins when a caller supplies one, and the
 *  `maxTokensEnv` / `defaultMaxTokens` config knobs (GH #7) slot in between —
 *  the chain collapses to a single constant at construction. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

function requireEnv(name: string, label: string, hint: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. ${label} adapter ${hint}`);
  return v;
}

/** Read an optional env knob's raw value. Unset, empty, or no configured env
 *  name = knob not engaged (empty-string-is-unset mirrors the base-URL
 *  convention). Returns the name alongside the value for error messages. */
function readEnvKnob(
  name: string | undefined,
): { name: string; raw: string } | undefined {
  if (!name) return undefined;
  const raw = process.env[name];
  if (!raw) return undefined;
  return { name, raw };
}

/** Read an optional positive-integer env knob (GH #7). A malformed value
 *  throws here — at construction, before any billable request — rather than
 *  sending a garbage `max_tokens` upstream. */
function readMaxTokensEnv(
  name: string | undefined,
  label: string,
): number | undefined {
  const knob = readEnvKnob(name);
  if (!knob) return undefined;
  const n = Number(knob.raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${knob.name}='${knob.raw}' is not a positive integer. ${label} adapter output-cap override must be a whole token count (e.g. 16384).`,
    );
  }
  return n;
}

/** Read an optional reasoning-effort env knob (GH #7). An unknown tier throws
 *  at construction with the allowed values (the wire-format vocabulary shared
 *  with `OpenAIChatRequest` — see REASONING_EFFORTS in openai-compat.ts). */
function readReasoningEffortEnv(
  name: string | undefined,
  label: string,
): ReasoningEffort | undefined {
  const knob = readEnvKnob(name);
  if (!knob) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(knob.raw)) {
    throw new Error(
      `${knob.name}='${knob.raw}' is not a valid reasoning effort. ${label} adapter accepts: ${REASONING_EFFORTS.join(" | ")}.`,
    );
  }
  return knob.raw as ReasoningEffort;
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
  // Treat empty string as unset (mirrors the OpenAI adapter's base-URL
  // handling). Vendors without a `defaultBaseUrl` (LM Studio) REQUIRE the env.
  const baseUrlRaw = process.env[cfg.baseUrlEnv];
  const baseUrlResolved =
    (baseUrlRaw && baseUrlRaw.length > 0 ? baseUrlRaw : undefined) ??
    cfg.defaultBaseUrl;
  if (!baseUrlResolved) {
    throw new Error(
      `${cfg.baseUrlEnv} is not set. ${cfg.label} adapter requires ${cfg.baseUrlEnv} (full base URL including /v1) — this vendor has no default base URL.`,
    );
  }
  const baseUrl = baseUrlResolved.replace(/\/+$/, "");

  // Env knobs (GH #7, extracted from draft PR #28) — read + validated once at
  // construction so a malformed value fails before the first billable request.
  const envMaxTokens = readMaxTokensEnv(cfg.maxTokensEnv, cfg.label);
  const envReasoningEffort = readReasoningEffortEnv(
    cfg.reasoningEffortEnv,
    cfg.label,
  );
  // Both resolve to constants for the adapter's lifetime, so collapse them
  // here — the per-request build below only asks "did the caller override?".
  const defaultMaxTokens =
    envMaxTokens ?? cfg.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  // Per-vendor extras (GH #8) + the env-driven reasoning effort (GH #7). The
  // env knob merges after `extraBody` so an operator override beats a vendor
  // config's hardcoded effort (DeepSeek's "high").
  const extraBody = {
    ...(cfg.extraBody ?? {}),
    ...(envReasoningEffort ? { reasoning_effort: envReasoningEffort } : {}),
  };

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
        // DEFAULT_MAX_OUTPUT_TOKENS. Precedence: explicit caller value, then
        // the env-override/vendor-default chain resolved at construction.
        max_tokens: req.maxTokens ?? defaultMaxTokens,
        // Per-vendor extras (GH #8) + env-driven effort override (GH #7) —
        // merged after the base fields so those can't clobber them; see the
        // construction-time `extraBody` merge for the override ordering.
        ...extraBody,
      };
      // The harness thinking TIER (req.thinking) is NOT mapped to a vendor knob
      // here — no Responses API. Moonshot reasons by server-side default;
      // DeepSeek is turned on via `cfg.extraBody` (thinking enabled + top-level
      // reasoning_effort); LM Studio reasons opaquely (effort via the env knob
      // only). Moonshot's and DeepSeek's `reasoning_content` is captured by the
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
            // Mirrors the OpenAI adapter's throw shape so with-retry's
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
