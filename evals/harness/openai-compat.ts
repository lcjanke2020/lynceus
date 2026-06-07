// Shared OpenAI-compatible (Chat Completions) translation helpers.
//
// Lives between the cross-vendor `VendorAdapter` seam (`vendor.ts`) and
// the per-backend adapter modules that speak the OpenAI wire format —
// today: `openai-adapter.ts` (OpenAI proper, issue #50) and
// `lm-studio-adapter.ts` (LM Studio, which exposes an
// OpenAI-compatible `/v1/chat/completions` endpoint). The two share
// nearly identical request-building + response-parsing logic. Pulling
// them into one module:
//   - consolidates the OpenAI-compatible translation into one place;
//   - removes a meaningful chunk of duplicated translation code;
//   - lets future OpenAI-compat adapters (Together, Groq, Fireworks,
//     Azure OpenAI on a different base URL) reuse the same translation
//     without re-implementing tool_calls round-tripping.
//
// What lives here:
//   - `OpenAIChatRequest` / `OpenAIChatResponse` types — the shape both
//     adapters POST/parse.
//   - `translateMessages()` — Anthropic-shape `MessageParam[]` → OpenAI
//     `OpenAIChatMessage[]`, including `tool_use` → `tool_calls` and
//     `tool_result` → `{ role: "tool", tool_call_id, content }` fan-out.
//   - `translateTools()` — Anthropic `Tool[]` → OpenAI
//     `{ type: "function", function: { name, description, parameters } }[]`.
//     Drops `cache_control` (LM Studio + OpenAI both ignore it — Anthropic
//     prompt-cache hints, see `lm-studio-adapter.ts` header).
//   - `translateResponse()` — OpenAI response → `NormalizedMessage`,
//     extracting text + tool_calls and surfacing the cache-token map via
//     a vendor-supplied extractor (so the OpenAI adapter populates the
//     `cachedTokens` key from `prompt_tokens_details` while LM Studio
//     populates nothing).
//   - `mapFinishReason()` — OpenAI `finish_reason` → `NormalizedMessage`
//     stop-reason enum.
//
// What does NOT live here:
//   - HTTP transport (each adapter handles its own `fetch` + auth headers).
//   - Vendor-specific env-var resolution.
//   - Reasoning-effort knobs — only OpenAI exposes them; the OpenAI
//     adapter constructs the request, then calls into here only for the
//     shared shape pieces.
//
// Field naming note: OpenAI's `usage.prompt_tokens` is documented as
// *including* cached tokens (cf. `prompt_tokens_details.cached_tokens`).
// The OpenAI adapter accounts for that asymmetry on the cost-billing
// side (see `model.ts` `estimateCostUsd`) — this module faithfully
// surfaces both numbers so the pricing layer can do the math without
// guessing.

import type {
  MessageParam,
  TextBlock,
  Tool,
} from "./anthropic.js";
import type {
  NormalizedMessage,
  NormalizedThinkingBlock,
  NormalizedToolUseBlock,
} from "./vendor.js";

/** A single OpenAI chat-completions message — either system / user /
 *  assistant (optionally carrying `tool_calls`) or a `tool` result
 *  referencing a prior `tool_call.id`. */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  /** Moonshot (Kimi) K2 Thinking: the chain-of-thought echoed back on an
   *  assistant tool-call turn. Required by Moonshot when thinking is on;
   *  unused by other OpenAI-compat backends. */
  reasoning_content?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** The (subset of) Chat Completions request body both OpenAI and
 *  LM Studio accept. OpenAI-specific additions like `reasoning_effort`
 *  and `max_completion_tokens` are bolted on by the OpenAI adapter
 *  after this base is built; LM Studio uses `max_tokens` directly. */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: unknown;
    };
  }>;
  tool_choice?: "auto" | "none";
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  /** DeepSeek V4 reasoning toggle (GH #8). DeepSeek enables thinking via a
   *  nested object — NOT the top-level `reasoning_effort` OpenAI uses. Only
   *  `high` / `max` are accepted (`low`/`medium` map to `high`, `xhigh` to
   *  `max`); default effort is `high`. The deepseek adapter sets this via
   *  `extraBody`; other OpenAI-compat backends leave it unset. */
  thinking?: { type: "enabled" | "disabled"; reasoning_effort?: "high" | "max" };
}

/** Subset of the Chat Completions response shape we read.
 *
 *  `usage.prompt_tokens_details.cached_tokens` is OpenAI-specific (LM
 *  Studio omits the field) — see the OpenAI prompt-caching docs
 *  (<https://platform.openai.com/docs/guides/prompt-caching>). The
 *  shared translator surfaces it via the `cacheTokensFrom` extractor
 *  the caller supplies, so OpenAI populates `{cachedTokens: N}` while
 *  LM Studio leaves `cacheTokens` undefined. */
export interface OpenAIChatResponse {
  id?: string;
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      /** Moonshot (Kimi) K2 Thinking returns its reasoning here alongside
       *  content/tool_calls. Absent for the other OpenAI-compat backends. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    /** DeepSeek's context-cache accounting (LEO-233 §3). DeepSeek reports
     *  cache hits via these top-level fields rather than OpenAI's nested
     *  `prompt_tokens_details.cached_tokens` (which Moonshot uses). In both
     *  cases `prompt_tokens` INCLUDES the cached portion. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/** Translate Anthropic-shape `system` + `messages` to OpenAI chat
 *  messages. Folds an assistant turn's `text` + `tool_use` blocks into
 *  one `{ role: "assistant", content, tool_calls }` message; splits a
 *  user turn's `tool_result` blocks into one `{ role: "tool", … }`
 *  message per result (OpenAI requires this fan-out — there is no
 *  multi-tool-result message shape).
 *
 *  Anthropic-signed thinking / redacted_thinking blocks on assistant turns
 *  are dropped — Chat Completions can't round-trip them. EXCEPTION: a
 *  moonshot-tagged thinking block is re-emitted as `reasoning_content`, which
 *  Kimi K2 Thinking requires echoed back on tool-call turns (see
 *  `translateResponse` for the capture side). A deepseek-tagged block is
 *  deliberately NOT re-emitted (it stays dropped): DeepSeek 400s if
 *  `reasoning_content` is present in input — the mirror opposite of Kimi
 *  (GH #8). So the re-emit gate stays narrowly `vendor === "moonshot"`. */
export function translateMessages(
  system: string | TextBlock[],
  messages: MessageParam[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];

  const systemText =
    typeof system === "string"
      ? system
      : system.map((b) => b.text).join("\n\n");
  if (systemText) out.push({ role: "system", content: systemText });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      let reasoning = "";
      const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = [];
      for (const block of m.content as unknown as Array<{
        type: string;
        [k: string]: unknown;
      }>) {
        if (block.type === "text") {
          text += String(block.text ?? "");
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: String(block.id),
            type: "function",
            function: {
              name: String(block.name),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "thinking" && block.vendor === "moonshot") {
          // Re-emit Moonshot's reasoning_content on the assistant turn — K2
          // Thinking hard-rejects a tool-call message that omits it. Gated on
          // the moonshot tag so other vendors' thinking blocks stay dropped.
          reasoning += String(block.thinking ?? "");
        }
        // other thinking / redacted_thinking blocks are dropped — see header.
      }
      const msg: OpenAIChatMessage = {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      out.push(msg);
    } else {
      // User turn: may carry tool_result blocks. Each becomes a separate
      // OpenAI `{ role: "tool", tool_call_id, content }` message.
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
            role: "tool",
            tool_call_id: String(block.tool_use_id),
            content,
          });
        }
      }
      if (userText) out.push({ role: "user", content: userText });
    }
  }
  return out;
}

/** Translate Anthropic `Tool[]` to OpenAI `tools` array. `cache_control`
 *  on the last tool (an Anthropic prompt-cache breakpoint marker) is
 *  dropped — OpenAI handles caching automatically and would 400 on the
 *  unknown field; LM Studio ignores it but the same translation runs in
 *  both paths so dropping it here is the simpler rule. */
export function translateTools(
  tools: Tool[],
): NonNullable<OpenAIChatRequest["tools"]> {
  return tools.map((t) => {
    const { cache_control: _drop, ...rest } = t as Tool & {
      cache_control?: unknown;
    };
    return {
      type: "function",
      function: {
        name: rest.name,
        description: rest.description ?? "",
        parameters: rest.input_schema,
      },
    };
  });
}

/** Translate an OpenAI chat-completions response into the cross-vendor
 *  `NormalizedMessage`.
 *
 *  `cacheTokensFrom` is a per-adapter extractor — the OpenAI adapter
 *  reads `usage.prompt_tokens_details.cached_tokens` into a
 *  `{ cachedTokens }` map; LM Studio returns `undefined` (the response
 *  carries no cache info). Keeping this caller-supplied (rather than
 *  inferring from response shape) means a future Together/Groq/Fireworks
 *  adapter can plug in its own vendor-native cache key without forking
 *  the translator. */
export function translateResponse(
  oResp: OpenAIChatResponse,
  idPrefix: string,
  cacheTokensFrom?: (
    usage: OpenAIChatResponse["usage"],
  ) => Record<string, number> | undefined,
): NormalizedMessage {
  const choice = oResp.choices[0];
  if (!choice) {
    throw new Error(`${idPrefix} response had no choices`);
  }
  const content: NormalizedMessage["content"] = [];
  // Moonshot (Kimi) and DeepSeek (V4) both return their chain-of-thought in
  // `reasoning_content`. Capture it as a vendor-tagged thinking block so the
  // runner traces it to the `.thinking` sidecar. Gated on the vendor
  // (idPrefix) so the cache-/reasoning-free OpenAI-compat backends
  // (openai, lm-studio) are byte-identical to before.
  //
  // The MIRROR-OPPOSITE re-feed behavior lives in `translateMessages`, NOT
  // here: a moonshot block is re-emitted as `reasoning_content` (K2 hard-
  // rejects a tool-call turn that OMITS it); a deepseek block is dropped
  // (DeepSeek 400s if `reasoning_content` is PRESENT in input). The tag
  // carried on the block is what selects between those two paths.
  const reasoningVendor: "moonshot" | "deepseek" | undefined =
    idPrefix === "moonshot" ? "moonshot" : idPrefix === "deepseek" ? "deepseek" : undefined;
  const reasoning = reasoningVendor ? choice.message.reasoning_content : undefined;
  if (reasoningVendor && typeof reasoning === "string" && reasoning.length > 0) {
    // Cast: TS can't narrow an object whose `vendor` is a 2-literal union to a
    // single union member (`moonshot` / `deepseek` blocks are distinct members).
    // `reasoningVendor` is a proper literal so the assertion is sound.
    content.push({
      type: "thinking",
      vendor: reasoningVendor,
      thinking: reasoning,
    } as NormalizedThinkingBlock);
  }
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content } as TextBlock);
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(tc.function.arguments || "{}");
    } catch {
      parsed = { _raw: tc.function.arguments };
    }
    const tu: NormalizedToolUseBlock = {
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: parsed,
    };
    content.push(tu);
  }

  const cacheTokens = cacheTokensFrom?.(oResp.usage);

  return {
    id: oResp.id ?? `${idPrefix}-${Date.now()}`,
    content,
    stopReason: mapFinishReason(choice.finish_reason),
    usage: {
      inputTokens: oResp.usage?.prompt_tokens ?? 0,
      outputTokens: oResp.usage?.completion_tokens ?? 0,
      ...(cacheTokens && Object.keys(cacheTokens).length > 0
        ? { cacheTokens }
        : {}),
    },
    // _rawAnthropicContent intentionally absent — neither OpenAI nor
    // LM Studio emit Anthropic-shaped content blocks. The runner falls
    // back to the normalized `content` when re-feeding the transcript.
  };
}

/** Map OpenAI's `finish_reason` enum onto the vendor-agnostic
 *  `NormalizedMessage.stopReason`. */
export function mapFinishReason(fr: string): NormalizedMessage["stopReason"] {
  switch (fr) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}
