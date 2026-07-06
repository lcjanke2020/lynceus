// Vertex (Gemini) VendorAdapter — issue #51.
//
// Production adapter for Vertex AI's Gemini family via the
// `@google/genai` Node SDK (`vertexai: true`). Lands the fourth backend
// alongside Anthropic (#47), OpenAI Chat Completions (#50) +
// OpenAI Responses (#58), and the LM Studio investigation artifact.
// This closes the issue-#45 multi-backend burst — three production
// vendors (Anthropic + OpenAI + Vertex) with full reasoning coverage,
// plus the LM Studio reference adapter on master.
//
// Design: direct Vertex SDK, NOT ADK-for-Vertex — for cache-extraction
// fidelity, a single MCP path, and a smaller dependency footprint.
//
// Auth setup: Google Application Default Credentials (gcloud + ADC, or
// a service account) — see
// https://cloud.google.com/docs/authentication/application-default-credentials.
// gemini-3.1-pro-preview is the known-working default; `location=global`
// (NOT us-central1) is required for preview 3.x models.
//
// ## Reasoning / thinking model
//
// The harness's abstract `ReasoningTier` (low | medium | high | xhigh |
// max) maps to `thinkingConfig.thinkingBudget` via `TIER_BUDGET_TOKENS`
// in `model.ts` — same numeric values used for Anthropic budget-mode.
// `thinkingConfig.includeThoughts: true` is set whenever thinking is
// enabled; without it, Gemini drops the thought parts (and their
// signatures) from the response entirely. The Vertex variant of
// `NormalizedThinkingBlock` carries `thoughtSignature` — Gemini's
// opaque per-thought-part round-trip blob, analogous to OpenAI's
// `encryptedContent` (#58). The adapter MUST re-emit `thoughtSignature`
// on subsequent turns or Gemini drops the thought from the model's
// reasoning context (silently — same failure mode as missing
// Anthropic `signature` on adaptive thinking turns).
//
// ## Explicit cache lifecycle
//
// Per the design-doc cache-parity table (line 73) and the ADK rebuttal
// (line 227), Vertex caching is wired via the explicit `cachedContents`
// API rather than relying on implicit cache hits. Lifecycle is
// scenario-scoped — see the per-call algorithm in `messages()`:
//
//   1. Hash the static prefix (system + tools).
//   2. If hash != current cache's hash, delete the current cache
//      (best-effort) and create a new one carrying the prefix.
//   3. Build the per-iter request omitting system + tools, with
//      `cachedContent: <cache name>`.
//   4. After the trial, the runner calls `endScenario()` which
//      deletes the active cache resource.
//
// Why the hash check: across a single trial the prefix is stable so
// the cache is created once on iter 1 and reused on every subsequent
// iter. Across scenarios within one CLI invocation, the runner spins
// up a fresh adapter per `runTrial()` call (verify: cli.ts:225-232),
// so cache state is implicitly per-trial; the hash check is a
// safety net in case a future code path reuses adapters across
// prefixes.
//
// Why 30-min TTL: scenarios run in 1-5 min typically; long-running
// debug sessions can stretch but ~30 min is comfortable headroom.
// Short TTLs risk mid-trial expiry → fall-back to non-cached billing
// silently (the API doesn't error if a referenced cache has expired —
// it just doesn't apply the discount).
//
// ## What's STUBBED (and why)
//
//   - Implicit-cache fallback: if `caches.create` fails (auth scope
//     missing, regional outage), the adapter throws rather than
//     transparently switching to non-cached requests. A future
//     follow-up can add the fallback; for v1 the explicit-only path
//     surfaces problems loudly.
//   - Streaming responses: harness uses non-stream `generateContent`.
//     Matches the Anthropic / OpenAI / LM Studio adapters.
//   - Modality details: the harness is text + function-calling only,
//     so we don't read `cacheTokensDetails` / `promptTokensDetails`
//     modality breakdowns. If a future scenario adds vision, revisit.
//   - Long-context output tier: Gemini 3.1 Pro Preview tiers BOTH
//     input and output at the 200K boundary. Encoded in `model.ts`
//     via `longContextOutput: 18.0` (1.5× the $12 base, matching the
//     GPT-5.5 output multiplier by coincidence). Pricing-page
//     footnote: "If a query input context is longer than 200K tokens,
//     all tokens (input and output) are charged at long context
//     rates."
//
// ## Env vars consumed
//
//   EVAL_PROVIDER             must be "vertex" for cli.ts to load this
//                             adapter at all.
//   EVAL_VERTEX_PROJECT_ID    GCP project id. Falls back to
//                             GOOGLE_CLOUD_PROJECT (the SDK's native
//                             env name) — hosts already wired for
//                             Vertex don't need a second var.
//   EVAL_VERTEX_LOCATION      Vertex location. Defaults to "global"
//                             per the setup doc — preview 3.x models
//                             only resolve at "global", NOT region
//                             ids like us-central1.
//   EVAL_VERTEX_MODEL_ID      Model id. Defaults to
//                             "gemini-3.1-pro-preview". Preview ids
//                             rotate without long notice — override
//                             via this var when Google retires the
//                             named id.
//
// Auth: standard SDK paths — ADC (`gcloud auth application-default
// login`) or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-
// account JSON. No adapter-specific auth env var; the SDK picks up
// whatever the host is configured for.

import { createHash } from "node:crypto";
import {
  GoogleGenAI,
  FinishReason,
  type CachedContent,
  type Content,
  type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
  type Tool as VertexTool,
} from "@google/genai";

import type {
  MessageParam,
  TextBlock,
  Tool,
} from "./anthropic.js";
import { TIER_BUDGET_TOKENS } from "./model.js";
import type {
  NormalizedMessage,
  NormalizedThinkingBlock,
  NormalizedToolUseBlock,
  ReasoningTier,
  VendorAdapter,
  VendorMessageRequest,
} from "./vendor.js";
import { TimeoutError, withRetry } from "./with-retry.js";

const DEFAULT_MODEL_ID = "gemini-3.1-pro-preview";
const DEFAULT_LOCATION = "global";
const CACHE_TTL_SECONDS = "1800s"; // 30 min — see header.

/** Map the harness's tier vocabulary to a Gemini `thinkingBudget`
 *  token count. Same numeric values used for Anthropic budget-mode
 *  (model.ts:136-142) — operator's mental model is "this tier gets
 *  this much room to think," vendor-agnostic. */
export function tierToVertexThinkingBudget(tier: ReasoningTier): number {
  return TIER_BUDGET_TOKENS[tier];
}

/** Build a Vertex `GenerateContentParameters`. Exported for tests so
 *  request shape can be pinned without standing up the SDK transport.
 *
 *  When `cacheName` is non-null, `systemInstruction` and `tools` are
 *  OMITTED from the request — they live in the cache resource. Setting
 *  them alongside `cachedContent` returns a 400. */
export function buildVertexRequest(
  model: string,
  req: VendorMessageRequest,
  toolNameByUseId: ReadonlyMap<string, string>,
  cacheName: string | null,
): GenerateContentParameters {
  const contents = translateMessages(req.messages, toolNameByUseId);

  const config: GenerateContentParameters["config"] = {};

  if (cacheName === null) {
    config.systemInstruction = systemToContent(req.system);
    if (req.tools && req.tools.length > 0) {
      config.tools = translateTools(req.tools);
    }
  } else {
    config.cachedContent = cacheName;
  }

  if (req.temperature !== undefined) {
    config.temperature = req.temperature;
  }

  if (req.thinking !== undefined) {
    config.thinkingConfig = {
      thinkingBudget: tierToVertexThinkingBudget(req.thinking.tier),
      // includeThoughts: true is REQUIRED for the round-trip to work
      // (header: "Reasoning / thinking model"). Without it, the model
      // still thinks but the response omits thought parts +
      // signatures, so subsequent turns lose the reasoning context.
      includeThoughts: true,
    };
  }

  return {
    model,
    contents,
    config,
  };
}

/** Hash the static prefix (system + tools) so the adapter can detect
 *  when the cache resource needs to be re-created. Stable across runs
 *  for a given prefix. Cryptographic hash isn't required — collision
 *  resistance gives us "different prefix → different hash"; a JSON-
 *  stringify + sha256 keeps the implementation portable and
 *  comparison-cheap. */
export function cachePrefixHash(
  system: VendorMessageRequest["system"],
  tools: VendorMessageRequest["tools"],
): string {
  const payload = JSON.stringify({ system, tools: tools ?? [] });
  return createHash("sha256").update(payload).digest("hex");
}

/** Walk a Gemini response into `NormalizedMessage`. Exported for tests
 *  so response parsing can be pinned without standing up the SDK
 *  transport. */
export function translateVertexResponse(
  resp: GenerateContentResponse,
  _model: string,
): NormalizedMessage {
  const candidate = resp.candidates?.[0];
  const parts: Part[] = candidate?.content?.parts ?? [];

  const content: NormalizedMessage["content"] = [];
  let toolCallIndex = 0;
  let hasFunctionCall = false;

  for (const part of parts) {
    // Thought parts come before / after their non-thought neighbors;
    // Gemini's API can emit summary text only ("text" + "thought:
    // true") OR opaque-only thoughts (no visible text — captured by
    // the signature alone). We surface both as NormalizedThinkingBlock
    // entries. The sidecar gets the visible thought text; the
    // signature carries the round-trip state.
    if (part.thought === true) {
      const block: NormalizedThinkingBlock = {
        type: "thinking",
        vendor: "vertex",
        thinking: part.text ?? "",
        thoughtSignature: part.thoughtSignature ?? "",
      };
      content.push(block);
      continue;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      const block: TextBlock = { type: "text", text: part.text };
      content.push(block);
      continue;
    }
    if (part.functionCall) {
      hasFunctionCall = true;
      const fc = part.functionCall;
      // Gemini's FunctionCall may omit `id` (Vertex matches by
      // position+name on the next turn). Synthesize a stable id so
      // the runner's tool_use_id round-trip has something to key on
      // — same shape OpenAI Responses uses with its `call_id`.
      const id = fc.id ?? `${fc.name ?? "function"}-${toolCallIndex}`;
      const tu: NormalizedToolUseBlock = {
        type: "tool_use",
        id,
        name: fc.name ?? "",
        input: fc.args ?? {},
        // Capture thoughtSignature when the SDK attaches one to the
        // functionCall part. Required when the call was preceded by
        // reasoning — Gemini 400s on the next turn without it. See
        // the `_thoughtSignature` field doc on NormalizedToolUseBlock
        // and the assistantContentToParts re-emission below.
        ...(part.thoughtSignature ? { _thoughtSignature: part.thoughtSignature } : {}),
      };
      content.push(tu);
      toolCallIndex += 1;
      continue;
    }
    // Other part shapes (inlineData, fileData, codeExecutionResult,
    // executableCode) — surface as empty; the harness doesn't drive
    // them today.
  }

  const stopReason = mapFinishReason(candidate?.finishReason, hasFunctionCall);

  const usage = resp.usageMetadata;
  // Gemini reports thinking tokens separately from candidate tokens.
  // For OUTPUT-rate billing we sum both — thinking is billed at the
  // model's output rate per the pricing page.
  const outputTokens =
    (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);

  const cacheTokens: Record<string, number> = {};
  if (usage?.cachedContentTokenCount !== undefined && usage.cachedContentTokenCount > 0) {
    cacheTokens.cachedContentTokens = usage.cachedContentTokenCount;
  }

  return {
    id: resp.responseId ?? "",
    content,
    stopReason,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens,
      ...(Object.keys(cacheTokens).length > 0 ? { cacheTokens } : {}),
    },
  };
}

/** Map Gemini's `FinishReason` enum to the cross-vendor stop reason.
 *  When the candidate contains any functionCall parts, the stop reason
 *  is `tool_use` regardless of the SDK-reported `finishReason` (Gemini
 *  signals tool use via the presence of functionCall parts, not via a
 *  distinct enum value — the SDK still reports STOP). */
function mapFinishReason(
  reason: FinishReason | string | undefined,
  hasFunctionCall: boolean,
): NormalizedMessage["stopReason"] {
  if (hasFunctionCall) return "tool_use";
  if (reason === undefined) return "other";
  if (reason === FinishReason.STOP) return "end_turn";
  if (reason === FinishReason.MAX_TOKENS) return "max_tokens";
  // SAFETY / RECITATION / LANGUAGE / BLOCKLIST / PROHIBITED_CONTENT /
  // SPII / MALFORMED_FUNCTION_CALL / IMAGE_SAFETY / OTHER /
  // FINISH_REASON_UNSPECIFIED → "other". The runner treats this as a
  // hard stop; the trace preserves the actual enum via the rest of
  // the candidate.
  return "other";
}

/** Coerce the harness's `system` (string | TextBlock[]) into Gemini's
 *  `Content` shape for use as the `systemInstruction` config field.
 *  The harness's TextBlock[] form may carry `cache_control` markers
 *  (Anthropic-specific); they are dropped here — Vertex uses the
 *  separate `cachedContents` resource for caching, not in-prompt
 *  markers.
 *
 *  Role is `"system"` for documentation clarity. Gemini ignores the
 *  role on `systemInstruction` (the field name carries the semantic)
 *  but the explicit value reads more naturally to operators reading
 *  trace files than the previously-used `"user"`. */
function systemToContent(system: VendorMessageRequest["system"]): Content {
  if (typeof system === "string") {
    return { role: "system", parts: [{ text: system }] };
  }
  const parts: Part[] = system.map((block) => ({ text: block.text }));
  return { role: "system", parts };
}

/** Translate Anthropic-shape tools to Gemini's `functionDeclarations`.
 *  Gemini accepts JSON-Schema for `parameters` (same convention the
 *  Anthropic Tool's `input_schema` uses), via `parametersJsonSchema`
 *  to avoid the SDK's `Schema` proto coercion. Drops Anthropic's
 *  `cache_control` if present at the tool level. */
function translateTools(tools: readonly Tool[]): VertexTool[] {
  const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    // `parametersJsonSchema` accepts the JSON-Schema verbatim. The
    // alternative `parameters` field expects an OpenAPI Schema proto
    // shape which the SDK coerces — using `parametersJsonSchema`
    // keeps the Anthropic input_schema round-tripping cleanly.
    parametersJsonSchema: t.input_schema,
  }));
  return [{ functionDeclarations }];
}

/** Translate the harness's `MessageParam[]` to Gemini's `Content[]`.
 *
 *  Messages are alternating user / assistant turns. User turns may
 *  carry text + tool_result blocks (lynceus scenarios don't use
 *  image). Assistant turns carry text + (vendor-tagged) thinking +
 *  tool_use blocks — for the Vertex path the assistant content is our
 *  normalized union (see runner.ts: the runner pushes
 *  `resp.content as MessageParam["content"]` for non-Anthropic
 *  vendors, where `resp.content` is the NormalizedMessage content
 *  union).
 *
 *  `toolNameByUseId` resolves `tool_result.tool_use_id` → the function
 *  name (Gemini's `functionResponse.name` is required; Anthropic's
 *  `tool_result` only carries the id). Pre-walked once per request to
 *  avoid an O(n²) scan. */
function translateMessages(
  messages: readonly MessageParam[],
  toolNameByUseId: ReadonlyMap<string, string>,
): Content[] {
  const out: Content[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const parts = userContentToParts(msg.content, toolNameByUseId);
      if (parts.length > 0) {
        out.push({ role: "user", parts });
      }
      continue;
    }
    // assistant
    const parts = assistantContentToParts(msg.content);
    if (parts.length > 0) {
      out.push({ role: "model", parts });
    }
  }
  return out;
}

function userContentToParts(
  content: MessageParam["content"],
  toolNameByUseId: ReadonlyMap<string, string>,
): Part[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const parts: Part[] = [];
  for (const block of content) {
    // The runner's user turns contain `text` and `tool_result` blocks
    // only (no `image` in lynceus scenarios). `block.type` is narrowed
    // by Anthropic's MessageParam types; cast as the parts we expect.
    const b = block as
      | { type: "text"; text: string }
      | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
    if (b.type === "text") {
      parts.push({ text: b.text });
      continue;
    }
    if (b.type === "tool_result") {
      const name = toolNameByUseId.get(b.tool_use_id) ?? "";
      // Anthropic's tool_result.content carries a JSON-stringified
      // payload (see runner.ts: `content: JSON.stringify(toolOut.content)`).
      // Gemini's functionResponse expects a structured `response`
      // object. Wrap under {output: ...} per the SDK convention, with
      // {error: ...} for the is_error path.
      const response = b.is_error
        ? { error: b.content }
        : { output: b.content };
      parts.push({
        functionResponse: {
          ...(b.tool_use_id ? { id: b.tool_use_id } : {}),
          name,
          response,
        },
      });
    }
  }
  return parts;
}

function assistantContentToParts(content: MessageParam["content"]): Part[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  const parts: Part[] = [];
  for (const block of content) {
    // For non-Anthropic vendors the runner casts the normalized
    // content union as `MessageParam["content"]`. The actual runtime
    // shape is `TextBlock | NormalizedToolUseBlock |
    // NormalizedThinkingBlock`. We discriminate on `type` + (for
    // thinking) `vendor`.
    const b = block as
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown; _thoughtSignature?: string }
      | NormalizedThinkingBlock;
    if (b.type === "text") {
      parts.push({ text: b.text });
      continue;
    }
    if (b.type === "tool_use") {
      // Re-emit thoughtSignature when present — Gemini's API rejects
      // the next turn (400) with "Function call is missing a
      // thought_signature in functionCall parts" if a tool call was
      // preceded by reasoning and we drop the blob. See the
      // _thoughtSignature field doc on NormalizedToolUseBlock for
      // why this is captured during response translation.
      parts.push({
        functionCall: {
          ...(b.id ? { id: b.id } : {}),
          name: b.name,
          args: (b.input as Record<string, unknown> | undefined) ?? {},
        },
        ...(b._thoughtSignature ? { thoughtSignature: b._thoughtSignature } : {}),
      });
      continue;
    }
    if (b.type === "thinking") {
      // Re-emit Vertex-vendor thinking with its thoughtSignature so
      // the model's reasoning context survives the turn boundary.
      // Other vendor variants (anthropic / openai) won't appear here
      // because we're in the Vertex adapter — but defensively skip
      // them if they do (e.g. a mid-trial vendor swap would be a bug
      // upstream, not something to crash the Vertex path on).
      if (b.vendor === "vertex") {
        // Gemini may emit thought parts in three shapes (per the
        // header §"Reasoning / thinking model"):
        //   - text + signature  ("summary" thought)
        //   - text only         (signature-less summary; rare)
        //   - signature only    ("opaque" thought — no visible text)
        // We must NOT re-emit `{ text: "" }` because the API rejects
        // empty-text parts in some versions (Opus PR-review observed).
        // Drop fields independently — emit whichever subset of
        // (text, thoughtSignature) is populated. Skip entirely if
        // both empty: nothing to round-trip.
        if (!b.thinking && !b.thoughtSignature) {
          continue;
        }
        parts.push({
          thought: true,
          ...(b.thinking ? { text: b.thinking } : {}),
          ...(b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {}),
        });
      }
      continue;
    }
    // redacted_thinking (anthropic-only) — skip in the Vertex path.
  }
  return parts;
}

/** Walk `messages` to build a `tool_use_id → function name` lookup so
 *  user-side tool_result blocks can populate Gemini's `functionResponse.name`. */
function buildToolNameMap(messages: readonly MessageParam[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      const b = block as { type: string; id?: string; name?: string };
      if (b.type === "tool_use" && b.id && b.name) {
        map.set(b.id, b.name);
      }
    }
  }
  return map;
}

export interface MakeVertexAdapterOpts {
  project?: string;
  location?: string;
  model?: string;
  /** Pre-built SDK client — exclusively for tests. Production code paths
   *  let the adapter construct its own from env vars. */
  ai?: GoogleGenAI;
}

export function makeVertexAdapter(opts: MakeVertexAdapterOpts = {}): VendorAdapter {
  const project =
    opts.project ??
    process.env.EVAL_VERTEX_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw new Error(
      "EVAL_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is required when EVAL_PROVIDER=vertex. See evals/harness/vertex-adapter.ts header.",
    );
  }
  const location = opts.location ?? process.env.EVAL_VERTEX_LOCATION ?? DEFAULT_LOCATION;
  const model = opts.model ?? process.env.EVAL_VERTEX_MODEL_ID ?? DEFAULT_MODEL_ID;

  const ai =
    opts.ai ??
    new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });

  // Scenario-scoped cache state. See header §"Explicit cache lifecycle".
  let currentCacheName: string | null = null;
  let currentCacheHash: string | null = null;

  async function deleteCurrentCache(): Promise<void> {
    if (currentCacheName === null) return;
    const name = currentCacheName;
    currentCacheName = null;
    currentCacheHash = null;
    try {
      await ai.caches.delete({ name });
    } catch (e) {
      // Best-effort — surface to stderr but don't fail the trial.
      // Stuck remote-side cleanup is the operator's problem, not the
      // green-trial result's.
      process.stderr.write(
        `[vertex-adapter] WARN: caches.delete(${name}) rejected: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  async function ensureCache(
    system: VendorMessageRequest["system"],
    tools: VendorMessageRequest["tools"],
    retryCtx: { timeoutMs?: number; onRetry?: VendorMessageRequest["onRetry"] },
  ): Promise<string> {
    const hash = cachePrefixHash(system, tools);
    if (currentCacheHash === hash && currentCacheName !== null) {
      return currentCacheName;
    }
    // Hash differs or no cache yet — drop the old and mint a new one.
    await deleteCurrentCache();
    // #63 review (PR #65, Codex/GPT-5 #2 round-1 + round-2):
    //
    // Round-1 #2 (a5cab61): wrap caches.create with withRetry so a
    // rejected TypeError fetch failed / ECONNRESET / 5xx no longer
    // aborts the whole trial.
    //
    // Round-2 #1 (this commit): withRetry only checks its deadline
    // BETWEEN attempts; it never races or aborts the in-flight fn().
    // A never-settling caches.create promise still hung the eval
    // indefinitely. Fix: pass a per-attempt AbortSignal into the SDK's
    // CreateCachedContentConfig.abortSignal (available since
    // @google/genai 2.x). On abort the SDK rejects with an AbortError,
    // which the classifier in with-retry.ts treats as retryable.
    //
    // Per-attempt cap is `min(retryCtx.timeoutMs, 5min)` — matches the
    // generateContent wrap (vertex-adapter.ts ~660) so a caller that
    // passes a small `req.timeoutMs` actually bounds each attempt's
    // hang time, not just the total. Round-3 Codex P3 nit: the
    // previous hard-coded 5min ignored shorter per-call deadlines.
    //
    // Trade-off (same as round-1): a transient that aborts client-side
    // after the request succeeded server-side leaves a dangling
    // CachedContent (per the SDK's own note: "AbortSignal is a
    // client-only operation"). Bounded by the 30-min TTL, acceptable.
    const created: CachedContent = await withRetry(
      async () => {
        const innerMs = Math.min(retryCtx.timeoutMs ?? 5 * 60 * 1000, 5 * 60 * 1000);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), innerMs);
        try {
          return await ai.caches.create({
            model,
            config: {
              systemInstruction: systemToContent(system),
              ...(tools && tools.length > 0 ? { tools: translateTools(tools) } : {}),
              ttl: CACHE_TTL_SECONDS,
              abortSignal: controller.signal,
            },
          });
        } finally {
          clearTimeout(timer);
        }
      },
      {
        vendor: "vertex",
        timeoutMs: retryCtx.timeoutMs,
        onRetry: retryCtx.onRetry,
      },
    );
    if (!created.name) {
      throw new Error(
        `vertex-adapter: caches.create returned a CachedContent with no name; cannot reference it on subsequent requests.`,
      );
    }
    currentCacheName = created.name;
    currentCacheHash = hash;
    return created.name;
  }

  return {
    vendor: "vertex",
    model,
    async messages(req: VendorMessageRequest): Promise<NormalizedMessage> {
      const cacheName = await ensureCache(req.system, req.tools, {
        timeoutMs: req.timeoutMs,
        onRetry: req.onRetry,
      });
      const toolNameByUseId = buildToolNameMap(req.messages);
      const vertexReq = buildVertexRequest(model, req, toolNameByUseId, cacheName);

      // #63: wrap the per-iter SDK call so transient network errors
      // (TypeError fetch failed, ECONNRESET, Vertex 5xx) get retried
      // with exponential backoff. The `@google/genai` SDK doesn't
      // document an AbortSignal hook on `generateContent`, so cap each
      // attempt with a Promise.race against a TimeoutError. The
      // classifier treats TimeoutError as retryable; the outer
      // `withRetry` deadline guarantees a true hang can't infinite-
      // retry.
      //
      // TODO: if a future SDK release exposes `requestOptions.signal`
      // or an `abortSignal` on `GenerateContentParameters`, swap the
      // Promise.race for `controller.abort()` without touching the
      // outer `withRetry` shape.
      return withRetry(
        async () => {
          // Worst case (Opus review #4 on PR #65): when `req.timeoutMs`
          // is undefined, `withRetry`'s outer deadline is Infinity AND
          // this per-attempt cap defaults to 5 min, so a hung Vertex
          // call bounds at ~15 min (3 attempts × 5 min). Strictly
          // better than the pre-#63 forever-hang, but don't lower the
          // per-attempt cap below the outer deadline thinking the
          // outer one covers retries — when undefined, it doesn't.
          const innerMs = Math.min(req.timeoutMs ?? 5 * 60 * 1000, 5 * 60 * 1000);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const resp = await Promise.race<GenerateContentResponse>([
              ai.models.generateContent(vertexReq),
              new Promise<GenerateContentResponse>((_, reject) => {
                timer = setTimeout(
                  () => reject(new TimeoutError(
                    `vertex: per-attempt timeout after ${innerMs} ms`,
                  )),
                  innerMs,
                );
              }),
            ]);
            return translateVertexResponse(resp, model);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
        {
          vendor: "vertex",
          timeoutMs: req.timeoutMs,
          onRetry: req.onRetry,
        },
      );
    },
    async endScenario(): Promise<void> {
      await deleteCurrentCache();
    },
  };
}
