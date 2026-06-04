// Anthropic implementation of the VendorAdapter seam (issue #47).
//
// This file used to be a thin wrapper around @anthropic-ai/sdk exposing
// an `AnthropicClient` interface that the runner consumed directly. With
// the #47 refactor it absorbs the Anthropic-specific request building
// and response translation that used to live in `runner.ts` — the
// runner now only sees the vendor-agnostic shapes from `vendor.ts`.
//
// What lives here:
//   - `makeAnthropicAdapter()`           — public entry, returns VendorAdapter.
//   - `buildAnthropicRequest()`          — translate VendorMessageRequest →
//                                          Anthropic SDK params. Exported
//                                          for the adapter test.
//   - `effectiveTokenCap()`              — per-trial output-token cap.
//                                          Exported; runner uses it for
//                                          the per-iter ceiling check.
//   - `RESPONSE_HEADROOM_TOKENS`         — exported headroom constant.
//   - `splitAssistantContent()`          — @internal, kept exported for
//                                          regression tests on
//                                          thinking-block edge cases.
//   - `readCacheUsage()`                 — @internal, ditto.
//
// Cache control (cost-critical):
// callers pass `cache_control: { type: "ephemeral" }` on the last block
// of the system prompt and the last entry of the tools array. The
// per-trial messages (scenario prompt + running tool_call/tool_result
// transcript) are NOT marked — they're per-trial and shouldn't waste
// cache budget. With this wiring the system + tools (~5K input tokens
// for the cdp-mcp tool surface) hit cache on every trial after the first.
// Verify post-deploy via the `cacheCreationInputTokens` /
// `cacheReadInputTokens` keys on `NormalizedMessage.usage.cacheTokens`.
//
// Thinking modes (Anthropic API split as of Opus 4.7):
//   - `budget` (Sonnet 4.6): `thinking: { type: "enabled", budget_tokens }`.
//   - `adaptive` (Opus 4.7): `thinking: { type: "adaptive", display }` +
//     `output_config: { effort }`. Pin display="summarized" — Opus 4.7
//     defaults to "omitted" (empty thinking text), which would make the
//     thinking sidecar useless for post-hoc analysis.

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
  ToolUseBlock,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
  MODEL_ID,
  SUPPORTS_TEMPERATURE,
  THINKING_STYLE,
  TIER_BUDGET_TOKENS,
  MAX_ITERATIONS_PER_TRIAL,
  MAX_OUTPUT_TOKENS_PER_TRIAL,
} from "./model.js";
import type { ReasoningConfig, ThinkingBlock } from "./types.js";
import type {
  NormalizedMessage,
  NormalizedThinkingBlock,
  NormalizedToolUseBlock,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { withRetry } from "./with-retry.js";

// Re-export the types the runner / tests still need, so consumers don't
// have to know which SDK we're using.
export type { Message, MessageParam, Tool, ToolUseBlock, TextBlock };

/** Headroom for the visible (non-thinking) part of the model's response.
 *  Per-request `max_tokens` is sized to `thinking_budget + this`; when
 *  thinking is disabled the request gets exactly this many tokens (the
 *  pre-thinking-support baseline). */
export const RESPONSE_HEADROOM_TOKENS = 4096;

/** Synthetic per-tier "budget" used when sizing `max_tokens` for
 *  adaptive-thinking models (Opus 4.7+). Adaptive doesn't let us specify
 *  a budget; the model self-allocates from `effort`. We still need an
 *  upper bound for `max_tokens` (which caps thinking + response combined
 *  per Anthropic's adaptive docs) so pick a generous approximation per
 *  tier — **deliberately 2× the budget-mode TIER_BUDGET_TOKENS defaults**
 *  to leave headroom for the model's self-allocated thinking on top of
 *  the visible response. `xhigh`/`max` are Opus 4.7+ only; sized
 *  generously since the docs explicitly note these tiers can exhaust
 *  `max_tokens` more often. */
const ADAPTIVE_TIER_MAXTOKENS_APPROX: Record<
  "low" | "medium" | "high" | "xhigh" | "max",
  number
> = {
  low: 8192,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
  max: 65536,
};

/** Compute the effective per-trial output-token cap.
 *
 *  Baseline = `MAX_OUTPUT_TOKENS_PER_TRIAL` when thinking is off. When
 *  thinking is on, scales up to `(budget + headroom) × iter_ceiling` so
 *  the cap doesn't trip on thinking tokens before the iter ceiling
 *  does. See model.ts:MAX_OUTPUT_TOKENS_PER_TRIAL doc. */
export function effectiveTokenCap(reasoning: ReasoningConfig): number {
  if (!reasoning.budgetTokens) return MAX_OUTPUT_TOKENS_PER_TRIAL;
  return Math.max(
    MAX_OUTPUT_TOKENS_PER_TRIAL,
    (reasoning.budgetTokens + RESPONSE_HEADROOM_TOKENS) * MAX_ITERATIONS_PER_TRIAL,
  );
}

/** Anthropic SDK request shape. Exported as `MessageRequest` for the
 *  adapter test (replaces what used to live at runner.ts:120). */
export interface MessageRequest {
  model: string;
  maxTokens: number;
  system: string | TextBlock[];
  messages: MessageParam[];
  tools?: Tool[];
  temperature?: number;
  timeoutMs?: number;
  thinking?:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive"; display?: "summarized" | "omitted" };
  outputConfig?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
}

/** Build the Anthropic Messages SDK request body from a vendor-agnostic
 *  VendorMessageRequest. This is where #47's tier-vocabulary
 *  ThinkingRequest gets translated to Anthropic's `thinking` +
 *  `output_config` SDK shape.
 *
 *  Test seam: exported so the adapter test can assert on `maxTokens`,
 *  `temperature`, and the `thinking` payload without spinning up the
 *  full trial machinery. */
export function buildAnthropicRequest(req: VendorMessageRequest): MessageRequest {
  const thinkingEnabled = req.thinking !== undefined;

  // Branch on the model's thinking style. Sonnet 4.6: explicit
  // budget_tokens (from override or tier default). Opus 4.7: adaptive +
  // effort tier (override is meaningless to adaptive — server self-
  // allocates).
  const effort = thinkingEnabled ? req.thinking!.tier : undefined;
  const budgetTokens =
    thinkingEnabled && req.thinking!.budgetTokensOverride !== undefined
      ? req.thinking!.budgetTokensOverride
      : thinkingEnabled
        ? TIER_BUDGET_TOKENS[req.thinking!.tier]
        : undefined;

  const adaptiveMaxOutput =
    effort !== undefined
      ? ADAPTIVE_TIER_MAXTOKENS_APPROX[effort] + RESPONSE_HEADROOM_TOKENS
      : RESPONSE_HEADROOM_TOKENS;

  // Caller can pass an explicit maxTokens; otherwise the adapter sizes
  // it from the thinking config (adaptive: tier-based approximation;
  // budget: budget + headroom; thinking off: just the headroom).
  const maxTokens =
    req.maxTokens ??
    (THINKING_STYLE === "adaptive"
      ? adaptiveMaxOutput
      : (budgetTokens ?? 0) + RESPONSE_HEADROOM_TOKENS);

  // On models that still accept `temperature`, Anthropic requires
  // `temperature: 1` when extended thinking is enabled. On newer
  // models (Opus 4.7+) the parameter is deprecated and the server 400s
  // on any value — omit it entirely there. Caller-supplied temperature
  // is honored only when the model supports it AND thinking is off; the
  // thinking-on path is forced to 1.
  let temperature: number | undefined;
  if (SUPPORTS_TEMPERATURE) {
    temperature = thinkingEnabled ? 1 : (req.temperature ?? 0);
  }

  return {
    model: MODEL_ID,
    maxTokens,
    system: req.system,
    messages: req.messages,
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    ...(thinkingEnabled
      ? THINKING_STYLE === "adaptive"
        ? {
            // Pin display: "summarized" — Opus 4.7 defaults to "omitted"
            // (empty thinking text, signatures only), which would render
            // the thinking sidecar useless for post-hoc analysis. The
            // server bills the same either way; this only affects what's
            // returned in the response stream.
            thinking: { type: "adaptive" as const, display: "summarized" as const },
            outputConfig: { effort: effort! },
          }
        : {
            thinking: {
              type: "enabled" as const,
              budget_tokens: budgetTokens!,
            },
          }
      : {}),
  };
}

export function makeAnthropicAdapter(apiKey?: string): VendorAdapter {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export it in your shell or pass apiKey to makeAnthropicAdapter().",
    );
  }
  const client = new Anthropic({ apiKey: key });
  return {
    vendor: "anthropic",
    model: MODEL_ID,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      const built = buildAnthropicRequest(req);
      // `thinking.type: "adaptive"` and the sibling `output_config` field
      // aren't yet in the SDK's static type for `MessageCreateParams` in
      // the version we pin, so we attach them via a widened type rather
      // than fighting the SDK types. The server accepts them; this only
      // affects type-checking in our codebase.
      // TODO: drop the `& Record<string, unknown>` widening once the SDK
      // bumps to a release that exposes `thinking.adaptive` + `output_config`.
      const params: Anthropic.Messages.MessageCreateParams & Record<string, unknown> = {
        model: built.model,
        max_tokens: built.maxTokens,
        system: built.system as Anthropic.Messages.MessageCreateParams["system"],
        messages: built.messages,
        ...(built.tools !== undefined ? { tools: built.tools } : {}),
        ...(built.temperature !== undefined ? { temperature: built.temperature } : {}),
      };
      if (built.thinking) params.thinking = built.thinking;
      if (built.outputConfig) params.output_config = built.outputConfig;
      // Defense in depth (#63): @anthropic-ai/sdk has its own internal
      // retry loop, so the harness was silently shielded from transient
      // network errors on the Anthropic path. Wrap anyway — when the
      // SDK's internal retries DO exhaust (or hit an error class the
      // SDK doesn't classify as retryable but we do), we still recover.
      return withRetry(
        async () => {
          const sdkResp = await client.messages.create(params, {
            timeout: built.timeoutMs ?? 5 * 60 * 1000,
          });
          return translateAnthropicResponse(sdkResp);
        },
        {
          vendor: "anthropic",
          timeoutMs: req.timeoutMs,
          onRetry: req.onRetry,
        },
      );
    },
  };
}

/** Translate an Anthropic SDK `Message` into the vendor-agnostic
 *  `NormalizedMessage` the runner consumes. Also populates the
 *  `_rawAnthropicContent` escape hatch so the runner can re-feed the
 *  assistant turn to the SDK preserving thinking-block signatures. */
function translateAnthropicResponse(msg: Message): NormalizedMessage {
  const cache = readCacheUsage(msg.usage);
  const content: NormalizedMessage["content"] = [];
  // Walk the SDK content array directly so the normalized order matches
  // the response order — text/tool_use/thinking blocks can interleave,
  // and downstream consumers (sidecar emission, transcript replay) need
  // the original ordering. `splitAssistantContent` (kept exported for
  // the regression tests) groups by type and would lose that ordering.
  type AnyBlock = { type: string; [k: string]: unknown };
  for (const block of msg.content as unknown as AnyBlock[]) {
    if (block.type === "text") {
      content.push({ type: "text", text: String(block.text ?? "") } as TextBlock);
    } else if (block.type === "tool_use") {
      const tu: NormalizedToolUseBlock = {
        type: "tool_use",
        id: String(block.id),
        name: String(block.name),
        input: block.input,
      };
      content.push(tu);
    } else if (block.type === "thinking") {
      const tb: NormalizedThinkingBlock = {
        type: "thinking",
        vendor: "anthropic",
        thinking: String(block.thinking ?? ""),
        signature: String(block.signature ?? ""),
      };
      content.push(tb);
    } else if (block.type === "redacted_thinking") {
      const tb: NormalizedThinkingBlock = {
        type: "redacted_thinking",
        vendor: "anthropic",
        data: String(block.data ?? ""),
      };
      content.push(tb);
    }
    // Unknown block types are dropped (forward-compat).
  }

  return {
    id: msg.id,
    content,
    stopReason: mapStopReason(msg.stop_reason),
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      // Cache keys use Anthropic-native names; the runner reads these
      // exact strings for the UsageEntry write (preserving on-disk trace
      // shape through #47). Phase D / #49 lifts this map directly into
      // the trace under `cacheTokens`.
      cacheTokens: {
        cacheCreationInputTokens: cache.cacheCreationInputTokens,
        cacheReadInputTokens: cache.cacheReadInputTokens,
      },
    },
    // Escape hatch: preserve the SDK content blocks verbatim so the
    // runner can re-feed the assistant turn (including thinking-block
    // `signature` fields required for adaptive round-trip) without
    // having to rebuild them from the normalized shape. Anthropic-
    // specific; other adapters leave this undefined.
    _rawAnthropicContent: msg.content,
  };
}

function mapStopReason(s: Message["stop_reason"]): NormalizedMessage["stopReason"] {
  switch (s) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
      return s;
    default:
      return "other";
  }
}

/** @internal Read cache_creation / cache_read input tokens from an
 *  assistant message's usage. Exported only so the
 *  `splitAssistantContent`-era regression tests can stay; the runner
 *  does not call this directly post-#47. */
export function readCacheUsage(usage: Message["usage"]): {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  const u = usage as Message["usage"] & {
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  return {
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** @internal Helper: extract concatenated text + tool_use + thinking
 *  blocks from an assistant message. Kept exported only so the
 *  regression tests for thinking-block edge cases (signature
 *  preservation, redacted_thinking, forward-compat on unknown blocks)
 *  keep working unchanged. Neither the runner nor
 *  `translateAnthropicResponse` calls it post-#47 — the latter does its
 *  own in-order walk because the grouped split loses block ordering. */
export function splitAssistantContent(msg: Message): {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  thinking: ThinkingBlock[];
} {
  let text = "";
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  const thinking: ThinkingBlock[] = [];
  type AnyBlock = { type: string; [k: string]: unknown };
  for (const block of msg.content as unknown as AnyBlock[]) {
    if (block.type === "text") {
      text += String(block.text ?? "");
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: String(block.id),
        name: String(block.name),
        input: block.input,
      });
    } else if (block.type === "thinking") {
      thinking.push({
        type: "thinking",
        thinking: String(block.thinking ?? ""),
        signature: String(block.signature ?? ""),
      });
    } else if (block.type === "redacted_thinking") {
      thinking.push({
        type: "redacted_thinking",
        data: String(block.data ?? ""),
      });
    }
  }
  return { text, toolUses, thinking };
}
