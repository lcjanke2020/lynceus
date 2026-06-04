// OpenAI Responses-API VendorAdapter — issue #58.
//
// Sibling to `openai-adapter.ts` (which speaks `/v1/chat/completions`).
// Lives behind the same `vendor: "openai"` brand but talks to the
// `/v1/responses` endpoint, which is the only OpenAI API surface that
// supports `tools` + `reasoning_effort` together on GPT-5.5 (the
// Chat Completions path returns a 400 directing callers here — that's
// what motivated #58).
//
// What this adapter buys on top of the #50 Chat-Completions adapter:
//   - Reasoning text capture (the summarized reasoning blocks land in
//     the thinking sidecar with `vendor: "openai"` + the round-trip
//     state).
//   - State preservation across multi-iter trials via OpenAI's
//     `encrypted_content` round-trip mechanism (stateless: trace files
//     stay self-contained and reproducible; we do NOT chain via
//     `previous_response_id`, which would tie state to OpenAI's server
//     retention).
//
// Why a sibling (not a single adapter routing internally): the two APIs
// have meaningfully different request/response shapes — `input` array
// vs `messages` array; `function_call` vs `tool_calls`;
// `function_call_output` vs `role: "tool"` messages; `output_text`
// content blocks vs string content; and the tool-definition shape is
// flat (`{type, name, description, parameters}`) on Responses vs nested
// (`{type, function: {...}}`) on Chat Completions. One adapter trying
// to handle both would grow unwieldy; the sibling shape matches the
// design decision (a) the operator approved post-#50.
//
// Why stateless (encrypted_content) over stateful (previous_response_id):
//   1. Trace files stay self-contained and reproducible — no dependency
//      on OpenAI's 30-day response retention.
//   2. Matches the Anthropic adapter's pattern (signature blobs in
//      thinking blocks; transcript replay from the messages array).
//   3. Avoids new runner state ("the previous OpenAI response id for
//      this trial") that doesn't generalize cross-vendor.
//
// What's REAL:
//   - Tool-use round-trip (Anthropic tool_use blocks <-> OpenAI
//     function_call items + function_call_output items).
//   - Reasoning round-trip via NormalizedThinkingBlock.encryptedContent
//     + itemId (the adapter re-emits these as `{type: "reasoning",
//     id, encrypted_content}` items on subsequent turns).
//   - Reasoning summary text captured into NormalizedThinkingBlock
//     `thinking` field (requires `reasoning.summary: "auto"`, which
//     the adapter sets unconditionally when thinking is requested).
//   - Usage extraction: input_tokens / output_tokens (includes
//     reasoning tokens — billed as output per OpenAI's docs);
//     cached_tokens from `usage.input_tokens_details.cached_tokens`.
//   - Long-context tier warning when prompt > 272K (same threshold +
//     pricing as Chat Completions; cost math lives in model.ts).
//
// Env vars consumed (same as the Chat Completions adapter):
//   EVAL_PROVIDER=openai
//   OPENAI_API_KEY
//   EVAL_OPENAI_MODEL
//   EVAL_OPENAI_BASE_URL (optional)

import type {
  MessageParam,
  TextBlock,
  Tool,
} from "./anthropic.js";
import type {
  NormalizedMessage,
  NormalizedThinkingBlock,
  NormalizedToolUseBlock,
  ReasoningTier,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { withRetry } from "./with-retry.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

/** Same per-tier approximation as the Chat Completions adapter, but
 *  the Responses API field name is `max_output_tokens` rather than
 *  `max_completion_tokens`. The numbers mirror Anthropic's
 *  ADAPTIVE_TIER_MAXTOKENS_APPROX so an operator's mental model
 *  ("medium gets this much room across vendors") stays portable. */
const OPENAI_TIER_MAXTOKENS_APPROX: Record<
  "low" | "medium" | "high" | "xhigh",
  number
> = {
  low: 8192,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
};

const RESPONSE_HEADROOM_TOKENS = 4096;

/** Tier vocabulary maps to Responses' four-level `reasoning.effort`
 *  enum. `max` clamps to `xhigh` (OpenAI's top tier). Same mapping as
 *  the Chat Completions adapter — kept module-local because the two
 *  adapters' tier-to-effort logic could plausibly diverge in the
 *  future (e.g. if OpenAI ships a different enum on Responses for
 *  some model family). */
export function tierToResponsesEffort(
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

// ─── Request shape ───────────────────────────────────────────────────

interface OpenAIResponsesInputItem {
  /** Item type discriminator. Top-level items are:
   *   - "message" with `role: "user"|"system"|"assistant"` + content[]
   *   - "function_call"  (assistant tool-call replay)
   *   - "function_call_output"  (user-side tool result)
   *   - "reasoning"  (round-trip of a prior reasoning item via
   *                   encrypted_content) */
  type: string;
  role?: "user" | "system" | "assistant";
  content?: Array<{ type: "input_text" | "output_text"; text: string }>;
  /** function_call fields */
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  /** function_call_output fields */
  output?: string;
  /** reasoning round-trip */
  encrypted_content?: string;
  summary?: Array<{ type: "summary_text"; text: string }>;
}

interface OpenAIResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
}

interface OpenAIResponsesRequest {
  model: string;
  input: OpenAIResponsesInputItem[];
  tools?: OpenAIResponsesTool[];
  reasoning?: {
    effort: "low" | "medium" | "high" | "xhigh";
    summary: "auto";
  };
  max_output_tokens?: number;
  include?: string[];
  /** `store: false` keeps the response off OpenAI's server (ZDR-style).
   *  Combined with `include: ["reasoning.encrypted_content"]`, this is
   *  the stateless round-trip path the adapter relies on. */
  store?: boolean;
}

// ─── Response shape ──────────────────────────────────────────────────

interface OpenAIResponsesOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  content?: Array<{ type: "output_text"; text: string }>;
  summary?: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string;
}

interface OpenAIResponsesResponse {
  id?: string;
  /** Top-level lifecycle state. "completed" is the happy path;
   *  "incomplete" means generation stopped before the model produced a
   *  natural end (most commonly hitting `max_output_tokens` on
   *  reasoning models). "failed" / "cancelled" mean the request did
   *  not produce a valid response and should not be normalized as a
   *  successful turn. Documented at
   *  <https://platform.openai.com/docs/guides/reasoning?api-mode=responses>.
   *  PR #61 review caught the absence of this check. */
  status?: "completed" | "incomplete" | "failed" | "cancelled" | "in_progress" | string;
  /** Populated when status === "incomplete". `reason` is typically
   *  "max_output_tokens" or "content_filter". */
  incomplete_details?: { reason?: string };
  /** Populated when status === "failed". */
  error?: { message?: string; type?: string; code?: string };
  output: OpenAIResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

// ─── Outbound translation: Anthropic-shape → Responses input items ────

/** Translate the cross-vendor system + messages array into the
 *  flattened top-level item sequence the Responses API expects. */
function translateToInput(
  system: string | TextBlock[],
  messages: MessageParam[],
): OpenAIResponsesInputItem[] {
  const out: OpenAIResponsesInputItem[] = [];

  const systemText =
    typeof system === "string"
      ? system
      : system.map((b) => b.text).join("\n\n");
  if (systemText) {
    out.push({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({
        type: "message",
        role: m.role,
        content: [{ type: "input_text", text: m.content }],
      });
      continue;
    }
    if (m.role === "assistant") {
      // Walk the assistant content blocks, emitting each at the top
      // level. Order matters: reasoning items must come before the
      // message/function_call items they preceded in the original
      // response, otherwise the model loses reasoning state for that
      // turn (per OpenAI's reasoning-items cookbook).
      for (const block of m.content as unknown as Array<{
        type: string;
        [k: string]: unknown;
      }>) {
        if (block.type === "text") {
          out.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: String(block.text ?? "") }],
          });
        } else if (block.type === "tool_use") {
          // Function-call replay. Per OpenAI's reasoning-items
          // cookbook the round-trip relies on `call_id` (which
          // function_call_output references on the next turn) +
          // `name` + `arguments`. The response's item-level `id`
          // (e.g. `fc_...`) is NOT preserved on
          // NormalizedToolUseBlock — we leave it off the replay
          // item; if a future OpenAI release tightens this, add an
          // optional `_itemId` to NormalizedToolUseBlock parallel to
          // the thinking block's `itemId`.
          //
          // Defensive `typeof === "string"` on `block.id` / `block.name`
          // — a hand-edited transcript or future code path that strips
          // either field would otherwise send the literal string
          // "undefined" to the API and produce a misleading error on
          // the next turn (PR #61 review).
          out.push({
            type: "function_call",
            call_id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "",
            arguments: JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === "thinking" && block.vendor === "openai") {
          // Round-trip the OpenAI reasoning item using its original
          // itemId + encrypted_content. The Responses API requires the
          // `summary` field on input reasoning items (empirically
          // validated by paid smoke 2026-05-18 — without it, the API
          // returns `400 Missing required parameter: 'input[N].summary'`).
          // Echo back the summary text so the trace stays
          // round-trippable; empty array when there's no summary text
          // to preserve.
          //
          // `typeof === "string"` coercions: the openish content walk
          // is typed as `[k: string]: unknown` to handle the
          // cross-vendor MessageParam shape, so `block.thinking` /
          // `block.itemId` aren't narrowed at compile time — narrow
          // here defensively. (PR #61 review caught the typecheck
          // error this fixes; coercing once at the top of the branch
          // also addresses the latent String(undefined) risk on
          // itemId for the same reason called out for tool_use above.)
          const thinkingText =
            typeof block.thinking === "string" ? block.thinking : "";
          const itemId =
            typeof block.itemId === "string" ? block.itemId : "";
          const summary =
            thinkingText.length > 0
              ? [{ type: "summary_text" as const, text: thinkingText }]
              : [];
          const item: OpenAIResponsesInputItem = {
            type: "reasoning",
            id: itemId,
            summary,
          };
          if (typeof block.encryptedContent === "string") {
            item.encrypted_content = block.encryptedContent;
          }
          out.push(item);
        }
        // Anthropic thinking / redacted_thinking blocks coming through
        // here would not round-trip on Responses (different reasoning
        // shape); the only realistic case where they'd appear is a
        // cross-vendor transcript, which is not a supported flow.
        // Drop silently.
      }
    } else {
      // User turn: text blocks become input_text on a user message;
      // tool_result blocks become top-level function_call_output items.
      let userText = "";
      for (const block of m.content as unknown as Array<{
        type: string;
        [k: string]: unknown;
      }>) {
        if (block.type === "text") {
          userText += String(block.text ?? "");
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content ?? "");
          out.push({
            type: "function_call_output",
            call_id: String(block.tool_use_id),
            output: content,
          });
        }
      }
      if (userText) {
        out.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText }],
        });
      }
    }
  }
  return out;
}

/** Tool definitions on Responses are FLAT (`{type, name, description,
 *  parameters}`), not nested (`{type, function: {name, ...}}`) like
 *  Chat Completions. Drops `cache_control` if present (Anthropic
 *  prompt-cache marker on the last tool). */
function translateToolsForResponses(tools: Tool[]): OpenAIResponsesTool[] {
  return tools.map((t) => {
    const { cache_control: _drop, ...rest } = t as Tool & {
      cache_control?: unknown;
    };
    return {
      type: "function",
      name: rest.name,
      description: rest.description ?? "",
      parameters: rest.input_schema,
    };
  });
}

// ─── Inbound translation: Responses output → NormalizedMessage ───────

function translateResponse(
  oResp: OpenAIResponsesResponse,
): NormalizedMessage {
  // PR #61 review (gpt-5): the Responses API returns HTTP 200 even on
  // failed / cancelled requests. Don't normalize those as successful
  // turns — the runner would treat them as `end_turn` and append a
  // truncated or empty assistant message to the transcript, then
  // (worse) bill the request's tokens against the budget on a result
  // that the model never actually produced. Surface as a thrown
  // error so the calling layer can decide whether to retry or abort.
  if (oResp.status === "failed" || oResp.status === "cancelled") {
    const detail = oResp.error?.message ?? oResp.error?.code ?? oResp.error?.type ?? "no error detail";
    // NOTE (Opus review #2 on PR #65): this throw deliberately carries
    // no HTTP-status digits — `withRetry`'s `extractStatus` regex
    // (`with-retry.ts:~200`) won't find a 3-digit code in the message,
    // so the classifier defaults to retry: false. That's correct
    // behavior: a failed/cancelled Responses turn is a model-side
    // decision, not a transient blip — retrying just bills more tokens
    // for the same outcome. If a future refactor adds a 3-digit code
    // (e.g. an HTTP-like error code in the body), it would silently
    // flip this to retry: true.
    throw new Error(
      `OpenAI Responses request returned status=${oResp.status}: ${detail}`,
    );
  }

  const content: NormalizedMessage["content"] = [];
  let stopReason: NormalizedMessage["stopReason"] = "end_turn";

  for (const item of oResp.output ?? []) {
    if (item.type === "reasoning") {
      // Concatenate all summary blocks into one thinking block. OpenAI
      // can return multiple summary_text entries per reasoning item;
      // we treat them as one summary for the sidecar.
      const thinking = (item.summary ?? [])
        .map((s) => s.text ?? "")
        .filter((t) => t.length > 0)
        .join("\n");
      const block: NormalizedThinkingBlock = {
        type: "thinking",
        vendor: "openai",
        thinking,
        itemId: String(item.id ?? ""),
        ...(typeof item.encrypted_content === "string"
          ? { encryptedContent: item.encrypted_content }
          : {}),
      };
      content.push(block);
    } else if (item.type === "message") {
      // Assistant message: concatenate output_text content blocks.
      const text = (item.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      if (text) {
        content.push({ type: "text", text } as TextBlock);
      }
    } else if (item.type === "function_call") {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(item.arguments ?? "{}");
      } catch {
        parsed = { _raw: item.arguments };
      }
      const tu: NormalizedToolUseBlock = {
        type: "tool_use",
        // Use call_id (referenced by function_call_output on the next
        // turn) as the NormalizedToolUseBlock id. The item-level `id`
        // is preserved separately for round-trip via the adapter's
        // own bookkeeping if ever needed — today the runner threads
        // the call_id through tool_result.tool_use_id, which the
        // outbound translator (translateToInput) consumes.
        id: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        input: parsed,
      };
      content.push(tu);
      stopReason = "tool_use";
    }
    // Other item types (web_search_call, file_search_call, etc.) are
    // not requested by this adapter and would be dropped. If we add
    // built-in tools later they'd need handling here.
  }

  // PR #61 review (gpt-5): override the default `end_turn` when the
  // response came back with status="incomplete". The most common
  // trigger is `max_output_tokens`, but content filter can also fire.
  // Only override when the walk above hasn't already set "tool_use" —
  // a request that produced a function_call before being truncated
  // should still execute the tool (the runner re-bills the next turn).
  if (oResp.status === "incomplete" && stopReason === "end_turn") {
    const reason = oResp.incomplete_details?.reason;
    stopReason = reason === "max_output_tokens" ? "max_tokens" : "other";
  }

  const cachedTokens = oResp.usage?.input_tokens_details?.cached_tokens;
  const cacheTokens: Record<string, number> | undefined =
    cachedTokens !== undefined && cachedTokens !== null
      ? { cachedTokens }
      : undefined;

  return {
    id: oResp.id ?? `openai-responses-${Date.now()}`,
    content,
    stopReason,
    usage: {
      inputTokens: oResp.usage?.input_tokens ?? 0,
      outputTokens: oResp.usage?.output_tokens ?? 0,
      ...(cacheTokens ? { cacheTokens } : {}),
    },
    // _rawAnthropicContent intentionally absent — Responses is its own
    // shape; round-trip happens via the normalized content + the
    // outbound translator's reasoning-item handling.
  };
}

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The OpenAI Responses adapter requires OPENAI_API_KEY and EVAL_OPENAI_MODEL (EVAL_OPENAI_BASE_URL optional). See evals/harness/openai-responses-adapter.ts header.`,
    );
  }
  return v;
}

/** Build the Responses-API request body. Exported for the adapter test
 *  so it can pin request shape without spinning up `fetch`. */
export function buildResponsesRequest(
  model: string,
  req: VendorMessageRequest,
): OpenAIResponsesRequest {
  const thinkingEnabled = req.thinking !== undefined;
  const effort = thinkingEnabled
    ? tierToResponsesEffort(req.thinking!.tier)
    : undefined;

  const maxOutputTokens =
    req.maxTokens ??
    (effort !== undefined
      ? OPENAI_TIER_MAXTOKENS_APPROX[effort] + RESPONSE_HEADROOM_TOKENS
      : RESPONSE_HEADROOM_TOKENS);

  const out: OpenAIResponsesRequest = {
    model,
    input: translateToInput(req.system, req.messages),
    max_output_tokens: maxOutputTokens,
    store: false,
    ...(req.tools && req.tools.length > 0
      ? { tools: translateToolsForResponses(req.tools) }
      : {}),
    ...(effort !== undefined
      ? {
          reasoning: { effort, summary: "auto" as const },
          include: ["reasoning.encrypted_content"],
        }
      : {}),
  };
  return out;
}

export interface MakeOpenaiResponsesAdapterOpts {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function makeOpenaiResponsesAdapter(
  opts: MakeOpenaiResponsesAdapterOpts = {},
): VendorAdapter {
  const apiKey = opts.apiKey ?? readEnv("OPENAI_API_KEY");
  const model = opts.model ?? readEnv("EVAL_OPENAI_MODEL");
  const baseUrl = (
    opts.baseUrl ||
    process.env.EVAL_OPENAI_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  return {
    vendor: "openai",
    model,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      const oReq = buildResponsesRequest(model, req);
      const url = `${baseUrl}/responses`;

      // #63: wrap the per-iter call so transient network errors get
      // retried with exponential backoff. The `status === "failed" |
      // "cancelled"` check inside `translateResponse` throws inside
      // the wrap; the classifier treats those as non-retryable
      // (model-side, not transient) because the message doesn't carry
      // an HTTP status code and `classifyByVendor` defaults to
      // retry:false for unknown errors.
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
            // for rationale. Attach status + Retry-After so 429
            // cooldowns are honored.
            throw Object.assign(
              new Error(
                `OpenAI Responses request failed: ${resp.status} ${resp.statusText} — ${body.slice(0, 500)}`,
              ),
              {
                status: resp.status,
                headers: { "retry-after": resp.headers.get("retry-after") ?? undefined },
              },
            );
          }
          const oResp = (await resp.json()) as OpenAIResponsesResponse;
          const normalized = translateResponse(oResp);

          // Long-context tier warning — same threshold + meaning as the
          // Chat Completions adapter (#50). Cost math lives in model.ts.
          if (normalized.usage.inputTokens > OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS) {
            process.stderr.write(
              `[openai-responses-adapter] WARN: input_tokens=${normalized.usage.inputTokens} > ${OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS} (GPT-5.5 long-context threshold). This request is billed at long-context rates ($10/Mtok input, $45/Mtok output).\n`,
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
