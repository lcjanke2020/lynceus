// INVESTIGATION ARTIFACT — NOT FOR MERGE TO MASTER.
//
// Throwaway proof-of-life adapter for issue #45 (multi-backend eval
// harness investigation). Demonstrates that the harness's tool-use loop
// can drive an LM Studio (OpenAI-compatible) backend.
//
// Post-#47 status: this adapter returns the real `VendorAdapter` shape
// (not a fake `AnthropicClient`) — the seam is no longer a
// throwaway-faking-Anthropic, it's a vendor-agnostic
// `messages(req): NormalizedMessage` contract.
//
// Post-#50 status: the inline OpenAI-shape translation helpers that used
// to live here have moved into `openai-compat.ts`, shared with the
// production OpenAI adapter. This file is now the thin LM-Studio-flavored
// wrapper: env-var resolution, HTTP transport, and the
// `cacheTokensFrom = undefined` choice (LM Studio has no prompt caching
// and reports no cached tokens).
//
// What's REAL:
//   - Tool-use round-trip (Anthropic tool_use blocks <-> OpenAI tool_calls)
//   - Usage extraction (prompt_tokens / completion_tokens -> input/output)
//   - Stop-reason translation
//   - Bearer-auth path (EVAL_LM_STUDIO_API_KEY env)
//   - System prompt + tools array flattened into the OpenAI request shape
//
// What's STUBBED (and why):
//   - `cache_control: ephemeral` on tools — dropped on the floor. LM
//     Studio has no prompt caching; `NormalizedMessage.usage.cacheTokens`
//     is left undefined (no zero-padding workaround needed post-#47).
//   - `thinking: ThinkingRequest` — dropped. LM Studio models that
//     reason do so opaquely; there is no `signature` to round-trip.
//     `NormalizedMessage.content` never carries thinking blocks.
//   - `redacted_thinking` — never emitted.
//   - `temperature` — passed through as-is when present.
//
// Env vars consumed:
//   EVAL_PROVIDER             — must be "lm-studio" for cli.ts to pick
//                               this adapter at all.
//   EVAL_LM_STUDIO_BASE_URL   — full base URL including /v1, e.g.
//                               "http://localhost:1234/v1". Required.
//   EVAL_LM_STUDIO_MODEL      — LM Studio model id, e.g.
//                               "openai/gpt-oss-120b". Required.
//   EVAL_LM_STUDIO_API_KEY    — Bearer token. Required if the LM Studio
//                               host is configured to expect one.

import {
  translateMessages,
  translateResponse,
  translateTools,
  type OpenAIChatRequest,
  type OpenAIChatResponse,
} from "./openai-compat.js";
import type {
  NormalizedMessage,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { withRetry } from "./with-retry.js";

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The LM Studio adapter requires EVAL_LM_STUDIO_BASE_URL, EVAL_LM_STUDIO_MODEL, and EVAL_LM_STUDIO_API_KEY. See evals/harness/lm-studio-adapter.ts header.`,
    );
  }
  return v;
}

export function makeLmStudioAdapter(): VendorAdapter {
  const baseUrl = readEnv("EVAL_LM_STUDIO_BASE_URL").replace(/\/+$/, "");
  const model = readEnv("EVAL_LM_STUDIO_MODEL");
  const apiKey = readEnv("EVAL_LM_STUDIO_API_KEY");

  return {
    vendor: "lm-studio",
    model,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      // LM Studio has no first-class output cap that mirrors Anthropic's
      // `max_tokens` semantics for thinking-bearing models. Use the
      // caller's value when supplied; otherwise default to 4096 (matches
      // the no-thinking branch of the Anthropic adapter for parity).
      const maxTokens = req.maxTokens ?? 4096;
      const oReq: OpenAIChatRequest = {
        model,
        messages: translateMessages(req.system, req.messages),
        ...(req.tools && req.tools.length > 0
          ? { tools: translateTools(req.tools), tool_choice: "auto" }
          : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        max_tokens: maxTokens,
      };
      // req.thinking is dropped — LM Studio has no first-class thinking
      // knob and no `signature` to round-trip.

      const url = `${baseUrl}/chat/completions`;

      // #63: same retry wrap as the production OpenAI adapter. LM Studio
      // is local so transient network errors are rare, but
      // ECONNREFUSED during a process flap (model unload/reload) is the
      // realistic failure mode and is now recoverable.
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
            // #63 review (PR #65, Codex/GPT-5 #1) — see openai-adapter.ts
            // for rationale.
            throw Object.assign(
              new Error(
                `LM Studio request failed: ${resp.status} ${resp.statusText} — ${body.slice(0, 500)}`,
              ),
              {
                status: resp.status,
                headers: { "retry-after": resp.headers.get("retry-after") ?? undefined },
              },
            );
          }
          const oResp = (await resp.json()) as OpenAIChatResponse;
          // cacheTokensFrom omitted — LM Studio reports no cache info, so
          // the shared translator leaves cacheTokens undefined (correct
          // trace shape for "no cache activity"; runner reads absent as 0).
          return translateResponse(oResp, "lm-studio");
        },
        {
          vendor: "lm-studio",
          timeoutMs: req.timeoutMs,
          onRetry: req.onRetry,
        },
      );
    },
  };
}
