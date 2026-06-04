import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinishReason,
  type CachedContent,
  type GenerateContentResponse,
  type GoogleGenAI,
} from "@google/genai";

import { TIER_BUDGET_TOKENS } from "./model.js";
import type { MessageParam, Tool } from "./anthropic.js";
import type { VendorMessageRequest } from "./vendor.js";
import {
  buildVertexRequest,
  cachePrefixHash,
  makeVertexAdapter,
  tierToVertexThinkingBudget,
  translateVertexResponse,
} from "./vertex-adapter.js";

const SYSTEM = "test-system";
const MESSAGES: MessageParam[] = [{ role: "user", content: "hello" }];
const TOOLS: Tool[] = [
  { name: "launch_chrome", description: "Launch a browser", input_schema: { type: "object" } },
];

const EMPTY_TOOL_MAP = new Map<string, string>();

// -----------------------------------------------------------------
// tierToVertexThinkingBudget
// -----------------------------------------------------------------

describe("tierToVertexThinkingBudget", () => {
  it("returns the TIER_BUDGET_TOKENS value for each tier (shared with Anthropic budget-mode)", () => {
    expect(tierToVertexThinkingBudget("low")).toBe(TIER_BUDGET_TOKENS.low);
    expect(tierToVertexThinkingBudget("medium")).toBe(TIER_BUDGET_TOKENS.medium);
    expect(tierToVertexThinkingBudget("high")).toBe(TIER_BUDGET_TOKENS.high);
    expect(tierToVertexThinkingBudget("xhigh")).toBe(TIER_BUDGET_TOKENS.xhigh);
    expect(tierToVertexThinkingBudget("max")).toBe(TIER_BUDGET_TOKENS.max);
  });
});

// -----------------------------------------------------------------
// buildVertexRequest
// -----------------------------------------------------------------

describe("buildVertexRequest", () => {
  it("no cache, no thinking: emits systemInstruction + tools, omits thinkingConfig + cachedContent", () => {
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages: MESSAGES, tools: TOOLS, temperature: 0.7 },
      EMPTY_TOOL_MAP,
      null,
    );
    expect(req.model).toBe("gemini-3.1-pro-preview");
    expect(req.config?.systemInstruction).toBeDefined();
    expect(req.config?.tools).toHaveLength(1);
    expect(req.config?.thinkingConfig).toBeUndefined();
    expect(req.config?.cachedContent).toBeUndefined();
    expect(req.config?.temperature).toBe(0.7);
  });

  it("thinking on: sets thinkingConfig with budget + includeThoughts=true", () => {
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages: MESSAGES, thinking: { tier: "medium" } },
      EMPTY_TOOL_MAP,
      null,
    );
    expect(req.config?.thinkingConfig).toEqual({
      thinkingBudget: TIER_BUDGET_TOKENS.medium,
      includeThoughts: true,
    });
  });

  it("cache active: omits systemInstruction + tools, sets cachedContent", () => {
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages: MESSAGES, tools: TOOLS },
      EMPTY_TOOL_MAP,
      "cachedContents/abc-123",
    );
    expect(req.config?.systemInstruction).toBeUndefined();
    expect(req.config?.tools).toBeUndefined();
    expect(req.config?.cachedContent).toBe("cachedContents/abc-123");
  });

  it("translates a user → assistant tool_use → user tool_result sequence into Gemini contents", () => {
    const toolMap = new Map([["call_a", "launch_chrome"]]);
    const messages: MessageParam[] = [
      { role: "user", content: "please launch" },
      {
        role: "assistant",
        // The runner pushes the assistant turn as the normalized
        // content union, cast as MessageParam["content"]. We
        // mirror that shape here.
        content: [
          { type: "text", text: "okay, launching" },
          {
            type: "tool_use",
            id: "call_a",
            name: "launch_chrome",
            input: { headless: true },
          },
        ] as never,
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_a",
            content: '{"status":"ok"}',
          },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages, tools: TOOLS },
      toolMap,
      null,
    );
    const contents = req.contents as Array<{
      role?: string;
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
        functionResponse?: { name?: string; response?: Record<string, unknown>; id?: string };
      }>;
    }>;
    expect(contents).toHaveLength(3);
    expect(contents[0]!.role).toBe("user");
    expect(contents[0]!.parts).toEqual([{ text: "please launch" }]);
    expect(contents[1]!.role).toBe("model");
    expect(contents[1]!.parts?.[0]?.text).toBe("okay, launching");
    expect(contents[1]!.parts?.[1]?.functionCall).toEqual({
      id: "call_a",
      name: "launch_chrome",
      args: { headless: true },
    });
    expect(contents[2]!.role).toBe("user");
    expect(contents[2]!.parts?.[0]?.functionResponse).toEqual({
      id: "call_a",
      name: "launch_chrome",
      response: { output: '{"status":"ok"}' },
    });
  });

  it("re-emits _thoughtSignature on functionCall parts (Gemini rejects next turn without it)", () => {
    // Regression: paid smoke against gemini-3.1-pro-preview returned
    // 400 "Function call is missing a thought_signature in functionCall
    // parts" — Gemini attaches thoughtSignature to functionCall parts
    // when the call was preceded by reasoning, and requires the blob
    // re-emitted on the next-turn assistant content.
    const messages: MessageParam[] = [
      { role: "user", content: "please launch" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_a",
            name: "launch_chrome",
            input: { headless: true },
            _thoughtSignature: "fc-sig-opaque",
          },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      EMPTY_TOOL_MAP,
      null,
    );
    const modelTurn = (
      req.contents as Array<{
        parts?: Array<{
          functionCall?: { name: string };
          thoughtSignature?: string;
        }>;
      }>
    )[1];
    expect(modelTurn?.parts).toEqual([
      {
        functionCall: {
          id: "call_a",
          name: "launch_chrome",
          args: { headless: true },
        },
        thoughtSignature: "fc-sig-opaque",
      },
    ]);
  });

  it("emits signature-only ('opaque') thought parts without an empty text field", () => {
    // Opus PR-review #1: a thought captured with empty text and a
    // non-empty signature must re-emit as `{ thought: true,
    // thoughtSignature }` — NOT `{ text: "", thought: true,
    // thoughtSignature }`, because the Vertex API may reject the
    // empty-text shape. The paid smoke happened not to exercise
    // this path (model emitted full text on every thought), so a
    // mock-SDK test is the only place this gets pinned.
    const messages: MessageParam[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "vertex",
            thinking: "",
            thoughtSignature: "opaque-blob",
          },
          { type: "text", text: "answer" },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      EMPTY_TOOL_MAP,
      null,
    );
    const modelTurn = (req.contents as Array<{ parts?: Array<Record<string, unknown>> }>)[1];
    expect(modelTurn?.parts).toEqual([
      { thought: true, thoughtSignature: "opaque-blob" },
      { text: "answer" },
    ]);
  });

  it("emits signature-less text-only thought parts (rare summary-only case)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "vertex",
            thinking: "loose thought, no sig",
            thoughtSignature: "",
          },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      EMPTY_TOOL_MAP,
      null,
    );
    const modelTurn = (req.contents as Array<{ parts?: Array<Record<string, unknown>> }>)[1];
    expect(modelTurn?.parts).toEqual([
      { thought: true, text: "loose thought, no sig" },
    ]);
  });

  it("drops thought blocks that have neither text nor signature (nothing to round-trip)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "thinking", vendor: "vertex", thinking: "", thoughtSignature: "" },
          { type: "text", text: "answer" },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      EMPTY_TOOL_MAP,
      null,
    );
    const modelTurn = (req.contents as Array<{ parts?: Array<Record<string, unknown>> }>)[1];
    // Only the text part survives — the degenerate thought block
    // (no text, no signature, nothing to carry) is dropped.
    expect(modelTurn?.parts).toEqual([{ text: "answer" }]);
  });

  it("re-emits vertex-vendor thinking blocks with thoughtSignature on subsequent turns", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "please think" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "vertex",
            thinking: "let me consider",
            thoughtSignature: "opaque-sig-1",
          },
          { type: "text", text: "the answer is 42" },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      EMPTY_TOOL_MAP,
      null,
    );
    const modelTurn = (req.contents as Array<{ parts?: Array<Record<string, unknown>> }>)[1];
    expect(modelTurn?.parts).toEqual([
      { text: "let me consider", thought: true, thoughtSignature: "opaque-sig-1" },
      { text: "the answer is 42" },
    ]);
  });

  it("wraps tool_result with is_error: true under {error: content} instead of {output: content}", () => {
    const toolMap = new Map([["call_b", "launch_chrome"]]);
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_b",
            content: '{"error":"transport_error"}',
            is_error: true,
          },
        ] as never,
      },
    ];
    const req = buildVertexRequest(
      "gemini-3.1-pro-preview",
      { system: SYSTEM, messages },
      toolMap,
      null,
    );
    const fr = (
      req.contents as Array<{
        parts?: Array<{ functionResponse?: { response?: Record<string, unknown> } }>;
      }>
    )[0]?.parts?.[0]?.functionResponse;
    expect(fr?.response).toEqual({ error: '{"error":"transport_error"}' });
  });
});

// -----------------------------------------------------------------
// cachePrefixHash
// -----------------------------------------------------------------

describe("cachePrefixHash", () => {
  it("returns the same hash for the same (system, tools) pair", () => {
    const a = cachePrefixHash(SYSTEM, TOOLS);
    const b = cachePrefixHash(SYSTEM, TOOLS);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes when the system changes", () => {
    const a = cachePrefixHash(SYSTEM, TOOLS);
    const b = cachePrefixHash(SYSTEM + " changed", TOOLS);
    expect(a).not.toBe(b);
  });

  it("returns different hashes when tools change", () => {
    const a = cachePrefixHash(SYSTEM, TOOLS);
    const b = cachePrefixHash(SYSTEM, [
      ...TOOLS,
      { name: "new_tool", input_schema: { type: "object" } },
    ]);
    expect(a).not.toBe(b);
  });

  it("treats undefined and [] tools as the same prefix (both are no-tools)", () => {
    expect(cachePrefixHash(SYSTEM, undefined)).toBe(cachePrefixHash(SYSTEM, []));
  });
});

// -----------------------------------------------------------------
// translateVertexResponse
// -----------------------------------------------------------------

function fakeResponse(overrides: Partial<GenerateContentResponse>): GenerateContentResponse {
  return overrides as GenerateContentResponse;
}

describe("translateVertexResponse", () => {
  it("walks text + thought + functionCall parts into NormalizedMessage", () => {
    const resp = fakeResponse({
      responseId: "resp-1",
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: {
            role: "model",
            parts: [
              { text: "let me think", thought: true, thoughtSignature: "sig-abc" },
              { text: "I'll call launch_chrome" },
              {
                functionCall: {
                  name: "launch_chrome",
                  args: { headless: true },
                },
                // Gemini attaches a thoughtSignature to the functionCall
                // part too when the call was preceded by reasoning.
                thoughtSignature: "fc-sig-xyz",
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 50,
        cachedContentTokenCount: 80,
      },
    });
    const out = translateVertexResponse(resp, "gemini-3.1-pro-preview");
    expect(out.id).toBe("resp-1");
    expect(out.stopReason).toBe("tool_use"); // presence of functionCall trumps STOP
    expect(out.content).toEqual([
      { type: "thinking", vendor: "vertex", thinking: "let me think", thoughtSignature: "sig-abc" },
      { type: "text", text: "I'll call launch_chrome" },
      {
        type: "tool_use",
        id: "launch_chrome-0", // synthesized when SDK omits FunctionCall.id
        name: "launch_chrome",
        input: { headless: true },
        _thoughtSignature: "fc-sig-xyz",
      },
    ]);
    expect(out.usage).toEqual({
      inputTokens: 100,
      // candidatesTokenCount (20) + thoughtsTokenCount (50). Both billed
      // at output rate per the Gemini 3.1 Pro Preview pricing page.
      outputTokens: 70,
      cacheTokens: { cachedContentTokens: 80 },
    });
  });

  it("uses FunctionCall.id when the SDK provides one", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "fc-server-issued",
                  name: "launch_chrome",
                  args: {},
                },
              },
            ],
          },
        },
      ],
    });
    const out = translateVertexResponse(resp, "gemini-3.1-pro-preview");
    expect(out.content).toEqual([
      { type: "tool_use", id: "fc-server-issued", name: "launch_chrome", input: {} },
    ]);
  });

  it("maps FinishReason.STOP without function calls to end_turn", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: { role: "model", parts: [{ text: "done" }] },
        },
      ],
    });
    expect(translateVertexResponse(resp, "x").stopReason).toBe("end_turn");
  });

  it("maps FinishReason.MAX_TOKENS to max_tokens", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.MAX_TOKENS,
          content: { role: "model", parts: [{ text: "trunc" }] },
        },
      ],
    });
    expect(translateVertexResponse(resp, "x").stopReason).toBe("max_tokens");
  });

  it("maps FinishReason.SAFETY (and other guardrail enums) to 'other'", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.SAFETY,
          content: { role: "model", parts: [] },
        },
      ],
    });
    expect(translateVertexResponse(resp, "x").stopReason).toBe("other");
  });

  it("omits cacheTokens when cachedContentTokenCount is 0/undefined", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: { role: "model", parts: [{ text: "x" }] },
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    expect(translateVertexResponse(resp, "x").usage.cacheTokens).toBeUndefined();
  });

  it("captures thoughtSignature as empty string when the SDK omits it", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: {
            role: "model",
            parts: [{ text: "raw thought", thought: true }],
          },
        },
      ],
    });
    expect(translateVertexResponse(resp, "x").content).toEqual([
      { type: "thinking", vendor: "vertex", thinking: "raw thought", thoughtSignature: "" },
    ]);
  });

  it("does NOT populate _rawAnthropicContent (Anthropic-only escape hatch)", () => {
    const resp = fakeResponse({
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: { role: "model", parts: [{ text: "x" }] },
        },
      ],
    });
    expect(translateVertexResponse(resp, "x")._rawAnthropicContent).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// makeVertexAdapter — cache lifecycle
// -----------------------------------------------------------------

describe("makeVertexAdapter — cache lifecycle (mocked SDK)", () => {
  const originalProjectVar = process.env.EVAL_VERTEX_PROJECT_ID;
  const originalGcpVar = process.env.GOOGLE_CLOUD_PROJECT;

  beforeEach(() => {
    process.env.EVAL_VERTEX_PROJECT_ID = "test-project";
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });
  afterEach(() => {
    if (originalProjectVar === undefined) delete process.env.EVAL_VERTEX_PROJECT_ID;
    else process.env.EVAL_VERTEX_PROJECT_ID = originalProjectVar;
    if (originalGcpVar === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalGcpVar;
  });

  function makeStubAi(): {
    ai: GoogleGenAI;
    createSpy: ReturnType<typeof vi.fn>;
    deleteSpy: ReturnType<typeof vi.fn>;
    generateSpy: ReturnType<typeof vi.fn>;
  } {
    let createCount = 0;
    const createSpy = vi.fn(async (): Promise<CachedContent> => {
      createCount += 1;
      return { name: `cachedContents/abc-${createCount}` };
    });
    const deleteSpy = vi.fn(async () => ({}));
    const generateSpy = vi.fn(
      async (): Promise<GenerateContentResponse> =>
        ({
          responseId: "resp-stub",
          candidates: [
            {
              finishReason: FinishReason.STOP,
              content: { role: "model", parts: [{ text: "ok" }] },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
        }) as GenerateContentResponse,
    );
    const ai = {
      caches: { create: createSpy, delete: deleteSpy },
      models: { generateContent: generateSpy },
    } as unknown as GoogleGenAI;
    return { ai, createSpy, deleteSpy, generateSpy };
  }

  it("populates vendor + model identity", () => {
    const { ai } = makeStubAi();
    const adapter = makeVertexAdapter({ ai, model: "gemini-3.1-pro-preview" });
    expect(adapter.vendor).toBe("vertex");
    expect(adapter.model).toBe("gemini-3.1-pro-preview");
  });

  it("defaults model to gemini-3.1-pro-preview when env unset", () => {
    const original = process.env.EVAL_VERTEX_MODEL_ID;
    delete process.env.EVAL_VERTEX_MODEL_ID;
    const { ai } = makeStubAi();
    expect(makeVertexAdapter({ ai }).model).toBe("gemini-3.1-pro-preview");
    if (original !== undefined) process.env.EVAL_VERTEX_MODEL_ID = original;
  });

  it("creates a cache on first messages() and reuses it on subsequent calls with the same prefix", async () => {
    const { ai, createSpy, deleteSpy, generateSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    const req: VendorMessageRequest = {
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    };
    await adapter.messages(req);
    await adapter.messages(req);
    await adapter.messages(req);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(0);
    expect(generateSpy).toHaveBeenCalledTimes(3);
    // The first call's request still references the same cache that
    // was created on that call — subsequent calls reference it too.
    for (const call of generateSpy.mock.calls) {
      const params = call[0] as { config?: { cachedContent?: string } };
      expect(params.config?.cachedContent).toBe("cachedContents/abc-1");
    }
  });

  it("deletes-then-recreates when the prefix hash changes mid-trial", async () => {
    const { ai, createSpy, deleteSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    await adapter.messages({ system: SYSTEM, messages: MESSAGES, tools: TOOLS });
    await adapter.messages({
      system: SYSTEM + " — changed",
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("endScenario deletes the active cache", async () => {
    const { ai, deleteSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    await adapter.messages({ system: SYSTEM, messages: MESSAGES, tools: TOOLS });
    await adapter.endScenario?.();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("endScenario is a no-op when no cache was created (no messages() yet)", async () => {
    const { ai, deleteSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    await adapter.endScenario?.();
    expect(deleteSpy).toHaveBeenCalledTimes(0);
  });

  it("endScenario swallows caches.delete errors and warns to stderr", async () => {
    const { ai, deleteSpy } = makeStubAi();
    deleteSpy.mockRejectedValueOnce(new Error("server unavailable"));
    const adapter = makeVertexAdapter({ ai });
    await adapter.messages({ system: SYSTEM, messages: MESSAGES, tools: TOOLS });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(adapter.endScenario?.()).resolves.toBeUndefined();
    const warned = errSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("caches.delete"));
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });

  it("throws a clear error when neither EVAL_VERTEX_PROJECT_ID nor GOOGLE_CLOUD_PROJECT is set", () => {
    delete process.env.EVAL_VERTEX_PROJECT_ID;
    expect(() => makeVertexAdapter({})).toThrow(/EVAL_VERTEX_PROJECT_ID/);
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when EVAL_VERTEX_PROJECT_ID is unset", () => {
    delete process.env.EVAL_VERTEX_PROJECT_ID;
    process.env.GOOGLE_CLOUD_PROJECT = "gcp-fallback-project";
    const { ai } = makeStubAi();
    expect(() => makeVertexAdapter({ ai })).not.toThrow();
  });

  // #63: retry/backoff wrap. Vertex was the original crash surface
  // (the 2026-05-18 partial run died on TypeError fetch failed during
  // adversarial-out-of-order trial 5/24).
  it("retries once on TypeError('fetch failed') then succeeds, emits one onRetry", async () => {
    const { ai, generateSpy } = makeStubAi();
    generateSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        responseId: "resp-recovered",
        candidates: [
          {
            finishReason: FinishReason.STOP,
            content: { role: "model", parts: [{ text: "ok" }] },
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      } as unknown as GenerateContentResponse);
    const adapter = makeVertexAdapter({ ai });
    const onRetry = vi.fn();
    const resp = await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      onRetry,
    });
    expect(resp.id).toBe("resp-recovered");
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].attempt).toBe(1);
    expect(onRetry.mock.calls[0]![0].error).toMatch(/fetch failed/);
  }, 10_000);

  it("treats a per-attempt TimeoutError as retryable (Vertex Promise.race surfaces it on hang)", async () => {
    const { TimeoutError } = await import("./with-retry.js");
    const { ai, generateSpy } = makeStubAi();
    // Reset the default ok-stub so we control both attempts.
    generateSpy.mockReset();
    generateSpy
      .mockRejectedValueOnce(new TimeoutError("vertex: per-attempt timeout after 100 ms"))
      .mockResolvedValueOnce({
        responseId: "resp-recovered",
        candidates: [
          {
            finishReason: FinishReason.STOP,
            content: { role: "model", parts: [{ text: "ok" }] },
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      } as unknown as GenerateContentResponse);
    const adapter = makeVertexAdapter({ ai });
    const onRetry = vi.fn();
    const resp = await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      onRetry,
    });
    expect(resp.id).toBe("resp-recovered");
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].error).toMatch(/per-attempt timeout/);
  }, 10_000);

  it("classifies a Vertex string-shaped 503 error as retryable", async () => {
    const { ai, generateSpy } = makeStubAi();
    generateSpy
      .mockRejectedValueOnce(new Error("[Vertex] 503 RESOURCE_EXHAUSTED"))
      .mockResolvedValueOnce({
        responseId: "resp-recovered",
        candidates: [
          {
            finishReason: FinishReason.STOP,
            content: { role: "model", parts: [{ text: "ok" }] },
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      } as unknown as GenerateContentResponse);
    const adapter = makeVertexAdapter({ ai });
    const resp = await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp.id).toBe("resp-recovered");
    expect(generateSpy).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("success on first try writes no adapter_retry events", async () => {
    const { ai, generateSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    const onRetry = vi.fn();
    await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      onRetry,
    });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // #63 review (PR #65, Codex/GPT-5 #2): `caches.create` used to be
  // the one Vertex SDK call outside the retry boundary. A transient
  // blip on the first iter's cache mint aborted the trial; now it's
  // wrapped in withRetry with the same classifier and per-iter
  // onRetry channel.
  it("retries caches.create on TypeError('fetch failed') and surfaces it through onRetry", async () => {
    const { ai, createSpy, generateSpy } = makeStubAi();
    createSpy.mockReset();
    createSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ name: "cachedContents/abc-1" });
    const adapter = makeVertexAdapter({ ai });
    const onRetry = vi.fn();
    const resp = await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      onRetry,
    });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(resp.id).toBe("resp-stub");
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].error).toMatch(/fetch failed/);
  }, 10_000);

  // #63 review (PR #65, Codex/GPT-5 round-2 #1): withRetry only
  // checks its deadline BETWEEN attempts; a never-settling
  // caches.create promise still hung the eval. Round-2 fix: pass a
  // per-attempt AbortSignal into CreateCachedContentConfig.
  it("passes a per-attempt abortSignal into the caches.create config", async () => {
    const { ai, createSpy } = makeStubAi();
    const adapter = makeVertexAdapter({ ai });
    await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const params = createSpy.mock.calls[0]![0] as {
      config?: { abortSignal?: unknown };
    };
    expect(params.config?.abortSignal).toBeInstanceOf(AbortSignal);
    // Signal is not yet aborted on a fast-resolving call.
    expect((params.config!.abortSignal as AbortSignal).aborted).toBe(false);
  });

  it("classifies an AbortError from caches.create as retryable (Codex round-2 #1 — hang recovery)", async () => {
    // Synthetic AbortError simulates what the SDK throws when the
    // per-attempt AbortSignal fires. The classifier in
    // with-retry.ts:isAbortError handles both DOMException AbortError
    // (newer Node) and Error.name === "AbortError" (older shapes).
    const { ai, createSpy } = makeStubAi();
    createSpy.mockReset();
    createSpy
      .mockRejectedValueOnce(
        typeof DOMException !== "undefined"
          ? new DOMException("aborted", "AbortError")
          : Object.assign(new Error("aborted"), { name: "AbortError" }),
      )
      .mockResolvedValueOnce({ name: "cachedContents/recovered" });
    const adapter = makeVertexAdapter({ ai });
    const onRetry = vi.fn();
    const resp = await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      onRetry,
    });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(resp.id).toBe("resp-stub");
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].error).toMatch(/aborted|AbortError/i);
  }, 10_000);
});
