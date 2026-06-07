// Vendor-agnostic seam for the L4 eval harness.
//
// This file introduces the vendor-agnostic seam. The eval runner used
// to consume Anthropic's `Message` shape directly — any non-Anthropic
// backend (e.g. the LM Studio investigation artifact, the upcoming
// Vertex/Gemini adapter for #51) had to either lie about
// Anthropic-wire-format fields (`cache_creation_input_tokens` etc.) or
// supply parallel "real" values elsewhere. `NormalizedMessage` makes the
// runner's response surface vendor-agnostic so adapters translate
// outward instead of faking inward.
//
// Phase B (this PR, #47) covers the seam only — runner consumes
// NormalizedMessage; Anthropic adapter populates the legacy cache field
// names so trace shape stays byte-identical. Trace migration (`provider`
// field, vendor-keyed `cacheTokens` map, vendor+model in filename) is
// Phase D / issue #49. Pricing namespace is Phase C / issue #48.

import type { Message, MessageParam, TextBlock, Tool } from "./anthropic.js";

export type Vendor =
  | "anthropic"
  | "openai"
  | "vertex"
  | "lm-studio"
  | "deepseek"
  | "moonshot";

/** Tier vocabulary the runner crosses the seam with. Each adapter maps
 *  the tier to its vendor-native concept:
 *  - Anthropic budget-mode: tier → default budget from TIER_BUDGET_TOKENS
 *    (or `budgetTokensOverride` when set).
 *  - Anthropic adaptive-mode: tier → `output_config.effort`.
 *  - Vertex (Gemini 3.x): tier → `thinking_config.thinking_budget`
 *    (Phase E / #51).
 *  - OpenAI: tier → reasoning effort param when the model supports it.
 *  - LM Studio: ignored (no first-class thinking knob). */
export type ReasoningTier = "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingRequest {
  tier: ReasoningTier;
  /** Explicit per-request budget. Only Anthropic budget-mode (Sonnet 4.6)
   *  reads this; adaptive-mode and other vendors ignore. */
  budgetTokensOverride?: number;
}

/** Vendor-agnostic request shape the runner passes to `VendorAdapter.messages()`.
 *
 *  `system`/`messages`/`tools` stay in the Anthropic-shape lingua franca
 *  for now — the LM Studio adapter already proves that inward
 *  translation works at the adapter boundary for those shapes. The
 *  vendor-agnostic dimensions added in #47 are `thinking` (was Anthropic-
 *  shaped `{ type: "adaptive"|"enabled", ... }` + sibling
 *  `output_config`) and the response side (`NormalizedMessage`). */
export interface VendorMessageRequest {
  /** Optional per-request output cap. When omitted, adapters pick a
   *  sensible default for the model + thinking tier — the Anthropic
   *  adapter applies `ADAPTIVE_TIER_MAXTOKENS_APPROX[effort] +
   *  RESPONSE_HEADROOM_TOKENS` for adaptive or `budget + headroom` for
   *  budget-mode. Other vendors map similarly. */
  maxTokens?: number;
  system: string | TextBlock[];
  messages: MessageParam[];
  tools?: Tool[];
  /** Caller intent. Anthropic adapter omits the SDK param entirely when
   *  the model is on the temperature-deprecated list (Opus 4.7+). Other
   *  adapters pass through. */
  temperature?: number;
  timeoutMs?: number;
  thinking?: ThinkingRequest;
  /** Adapter invokes once per RETRIED attempt (NOT on the successful
   *  attempt). The runner wires this to a closure that emits an
   *  `adapter_retry` trace entry (#63). Adapters that haven't wrapped
   *  their call with `withRetry` ignore it. */
  onRetry?: (event: { attempt: number; error: string; backoffMs: number }) => void;
}

export interface VendorAdapter {
  /** Stable identifier — appears in `ScenarioStartEntry.provider` post-#49. */
  readonly vendor: Vendor;
  /** Backend-actual model id (e.g. "claude-opus-4-7", "gemini-3.1-pro-preview"). */
  readonly model: string;
  messages(req: VendorMessageRequest): Promise<NormalizedMessage>;
  /** Optional scenario-scoped cleanup hook (#51). The runner calls this
   *  in the per-trial cleanup block so adapters holding cross-call
   *  resources can release them — today the Vertex adapter uses it to
   *  delete the `cachedContents` resource it created for the trial's
   *  static prefix. Adapters without scenario-scoped state leave it
   *  undefined; the runner no-ops via optional chaining. Best-effort —
   *  the runner catches + warns on rejection rather than failing the
   *  trial, because a stuck remote-side cleanup shouldn't lose a green
   *  trial result. */
  endScenario?(): Promise<void>;
}

export interface NormalizedToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Vendor-specific round-trip blob attached to the tool-use part.
   *  Today only Gemini uses this: when a functionCall part is
   *  preceded by reasoning, the SDK attaches a `thoughtSignature` to
   *  it as well as to the thought part, and the API REJECTS the
   *  next turn (400 `Function call is missing a thought_signature in
   *  functionCall parts`) if the signature isn't re-emitted on the
   *  re-fed assistant turn. The Vertex adapter captures the value
   *  here on response translation and re-emits it on the next-turn
   *  request translation; other adapters leave it undefined.
   *  Underscore prefix signals "internal escape hatch, not a stable
   *  part of the cross-vendor contract" — same convention as
   *  `_rawAnthropicContent` on `NormalizedMessage`. */
  _thoughtSignature?: string;
}

/** Vendor-tagged thinking, written to the thinking-sidecar NDJSON.
 *
 *  Anthropic's `signature` field stays inside the anthropic variant —
 *  required for round-trip on subsequent Anthropic turns; other vendors
 *  do not have an equivalent and must not leak it.
 *
 *  The OpenAI variant landed in #50 as a forward-looking type slot;
 *  #58 populates it from the Responses API. `itemId` is the response-
 *  item id required to feed the reasoning item back on subsequent
 *  turns (`{type: "reasoning", id, encrypted_content}` in the input
 *  array). `encryptedContent` is OpenAI's opaque per-item round-trip
 *  blob; the adapter requests `include: ["reasoning.encrypted_content"]`
 *  to populate it.
 *
 *  The Vertex variant landed in #51. `thoughtSignature` is Gemini's
 *  per-thought-part round-trip blob — the SDK populates it on each
 *  thought part when `thinkingConfig.includeThoughts: true` is set
 *  and the adapter MUST re-emit it on subsequent turns or Gemini
 *  drops the thought from the model's reasoning context. Empty
 *  string when absent (a thought part may legitimately have no
 *  signature — e.g. summary-only emissions). */
export type NormalizedThinkingBlock =
  | { type: "thinking"; vendor: "anthropic"; thinking: string; signature: string }
  | { type: "redacted_thinking"; vendor: "anthropic"; data: string }
  | {
      type: "thinking";
      vendor: "openai";
      thinking: string;
      itemId: string;
      encryptedContent?: string;
    }
  | {
      type: "thinking";
      vendor: "vertex";
      thinking: string;
      thoughtSignature: string;
    }
  | {
      // Moonshot (Kimi) K2 Thinking. Moonshot returns the chain-of-thought in
      // `reasoning_content` on the assistant message (Chat Completions) and
      // HARD-REJECTS a follow-up turn whose assistant tool-call message omits
      // it. The openai-compat adapter captures it here and re-emits it as
      // `reasoning_content` on the next-turn assistant message (LEO-233). No
      // signature/blob — it's plain reasoning text round-tripped verbatim.
      type: "thinking";
      vendor: "moonshot";
      thinking: string;
    }
  | {
      // DeepSeek (V4 thinking mode) — behaves like moonshot, NOT the mirror
      // opposite the old `deepseek-reasoner` guide described (GH #8). DeepSeek
      // returns its chain-of-thought in `reasoning_content` and REQUIRES it
      // echoed back on tool-call turns (the API rejects a tool-call message
      // that omits it — "reasoning_content ... must be passed back", verified
      // vs the live API). So the openai-compat adapter captures it here AND
      // re-emits it via translateMessages (gate widened to moonshot|deepseek).
      // Plain reasoning text, no signature/blob.
      type: "thinking";
      vendor: "deepseek";
      thinking: string;
    };

export interface NormalizedMessage {
  /** Adapter-issued id for trace correlation. */
  id: string;
  /** Vendor-agnostic content blocks — text + tool_use + (vendor-tagged)
   *  thinking. The runner reads only this. */
  content: Array<TextBlock | NormalizedToolUseBlock | NormalizedThinkingBlock>;
  /** Vendor-agnostic stop reason. Adapters map their native enum. */
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Vendor-specific cache token counts, keyed by vendor-native field
     *  name. The Anthropic adapter populates `cacheCreationInputTokens`
     *  and `cacheReadInputTokens` (the runner reads these exact keys for
     *  the UsageEntry write, which keeps the on-disk trace shape stable
     *  through #47). Other vendors populate their own keys (e.g.
     *  `cachedContentTokenCount` for Vertex). Phase D / #49 surfaces
     *  this map directly in the trace; until then the runner reads the
     *  Anthropic keys explicitly. */
    cacheTokens?: Record<string, number>;
  };
  /** Anthropic-only escape hatch — the exact SDK content blocks for
   *  transcript replay. The Anthropic adapter populates this so the
   *  runner can re-feed the assistant turn to the SDK preserving
   *  thinking-block `signature` fields (required for adaptive thinking
   *  round-trip). Other adapters leave this undefined; they own their
   *  own transcript-replay shape (which today means: the LM Studio
   *  adapter and the future Vertex adapter rebuild the assistant turn
   *  from the normalized content as needed).
   *
   *  Underscore prefix signals "internal escape hatch, not a stable part
   *  of the cross-vendor contract." */
  _rawAnthropicContent?: Message["content"];
}
