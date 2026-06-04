import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorMessageRequest } from "./vendor.js";
import {
  buildOpenaiRequest,
  makeOpenaiAdapter,
  tierToOpenaiEffort,
} from "./openai-adapter.js";

const SYSTEM = "test-system";
const MESSAGES: VendorMessageRequest["messages"] = [
  { role: "user", content: "hello" },
];
const TOOLS: NonNullable<VendorMessageRequest["tools"]> = [
  { name: "noop", input_schema: { type: "object" } },
];

describe("tierToOpenaiEffort", () => {
  it("passes through low / medium / high / xhigh (GPT-5.5's four-level enum)", () => {
    expect(tierToOpenaiEffort("low")).toBe("low");
    expect(tierToOpenaiEffort("medium")).toBe("medium");
    expect(tierToOpenaiEffort("high")).toBe("high");
    expect(tierToOpenaiEffort("xhigh")).toBe("xhigh");
  });

  it("clamps max down to xhigh (OpenAI's top tier)", () => {
    // PR #60 review (gpt-5 #2) corrected the pre-fix shape which
    // clamped both xhigh and max down to high — that would have
    // silently dropped the top reasoning tier once #58's Responses-API
    // path lifts the tools+reasoning gate.
    expect(tierToOpenaiEffort("max")).toBe("xhigh");
  });
});

describe("buildOpenaiRequest", () => {
  it("thinking off: no reasoning_effort, default max_completion_tokens=4096, temperature passes through", () => {
    const req = buildOpenaiRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      temperature: 0.7,
    });
    expect(req.model).toBe("gpt-5.5");
    expect(req.reasoning_effort).toBeUndefined();
    expect(req.max_completion_tokens).toBe(4096);
    expect(req.temperature).toBe(0.7);
    expect(req.tool_choice).toBe("auto");
    expect(req.tools).toHaveLength(1);
  });

  it("thinking on: reasoning_effort set, temperature dropped (reasoning models reject non-default)", () => {
    const req = buildOpenaiRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      temperature: 0.7,
      thinking: { tier: "medium" },
    });
    expect(req.reasoning_effort).toBe("medium");
    expect(req.temperature).toBeUndefined();
  });

  it("passes xhigh through; clamps only max to xhigh", () => {
    expect(
      buildOpenaiRequest("gpt-5.5", {
        system: SYSTEM,
        messages: MESSAGES,
        thinking: { tier: "xhigh" },
      }).reasoning_effort,
    ).toBe("xhigh");
    expect(
      buildOpenaiRequest("gpt-5.5", {
        system: SYSTEM,
        messages: MESSAGES,
        thinking: { tier: "max" },
      }).reasoning_effort,
    ).toBe("xhigh");
  });

  it("sizes max_completion_tokens from the thinking tier when thinking is on", () => {
    // PR #60 review (Claude + gpt-5 both flagged): the previous fixed
    // 4096 cap would truncate reasoning trials at the first iter.
    // Default now scales per-tier (mirrors Anthropic's
    // ADAPTIVE_TIER_MAXTOKENS_APPROX), with a 4096-token visible-
    // response headroom on top.
    const tierExpectations: Record<string, number> = {
      low: 8192 + 4096,
      medium: 16384 + 4096,
      high: 32768 + 4096,
      xhigh: 49152 + 4096,
      max: 49152 + 4096, // max clamps to xhigh
    };
    for (const [tier, expected] of Object.entries(tierExpectations)) {
      const req = buildOpenaiRequest("gpt-5.5", {
        system: SYSTEM,
        messages: MESSAGES,
        thinking: { tier: tier as never },
      });
      expect(req.max_completion_tokens, `tier ${tier}`).toBe(expected);
    }
  });

  it("uses caller-supplied maxTokens as max_completion_tokens (overrides per-tier default)", () => {
    const req = buildOpenaiRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "high" },
      maxTokens: 12_345,
    });
    expect(req.max_completion_tokens).toBe(12_345);
  });

  it("omits tools + tool_choice when none supplied", () => {
    const req = buildOpenaiRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
  });
});

describe("makeOpenaiAdapter — end-to-end via mocked fetch", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.EVAL_OPENAI_MODEL;
  const originalBase = process.env.EVAL_OPENAI_BASE_URL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.EVAL_OPENAI_MODEL = "gpt-5.5";
    delete process.env.EVAL_OPENAI_BASE_URL;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.EVAL_OPENAI_MODEL;
    else process.env.EVAL_OPENAI_MODEL = originalModel;
    if (originalBase === undefined) delete process.env.EVAL_OPENAI_BASE_URL;
    else process.env.EVAL_OPENAI_BASE_URL = originalBase;
    vi.unstubAllGlobals();
  });

  function stubFetchOk(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("populates vendor + model identity from env", () => {
    const adapter = makeOpenaiAdapter();
    expect(adapter.vendor).toBe("openai");
    expect(adapter.model).toBe("gpt-5.5");
  });

  it("posts to the default base URL with bearer auth + JSON content type", async () => {
    const fetchMock = stubFetchOk({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    await makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("honors EVAL_OPENAI_BASE_URL (Azure / proxy support)", async () => {
    process.env.EVAL_OPENAI_BASE_URL = "https://example.invalid/v1/";
    const fetchMock = stubFetchOk({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.invalid/v1/chat/completions");
  });

  it("populates cacheTokens.cachedTokens from usage.prompt_tokens_details.cached_tokens", async () => {
    stubFetchOk({
      id: "chatcmpl-99",
      choices: [
        { message: { role: "assistant", content: "answer" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 700 },
      },
    });
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheTokens: { cachedTokens: 700 },
    });
  });

  it("leaves cacheTokens undefined when the response omits prompt_tokens_details", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "x" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.usage.cacheTokens).toBeUndefined();
  });

  it("sends reasoning_effort + omits temperature when ThinkingRequest is set", async () => {
    const fetchMock = stubFetchOk({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    });
    await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      temperature: 0.5,
      thinking: { tier: "high" },
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBeUndefined();
    // high-tier default: 32768 + 4096 = 36864.
    expect(body.max_completion_tokens).toBe(36864);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("warns to stderr when a response's prompt_tokens crosses the long-context threshold", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      // 272_001 — one over the GPT-5.5 long-context threshold.
      usage: { prompt_tokens: 272_001, completion_tokens: 1 },
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const warned = errSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("long-context"));
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });

  it("does NOT warn when prompt_tokens is below the threshold", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100_000, completion_tokens: 1 },
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const warned = errSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("long-context"));
    expect(warned).toBe(false);
    errSpy.mockRestore();
  });

  it("treats EVAL_OPENAI_BASE_URL='' as unset (falls back to default)", async () => {
    process.env.EVAL_OPENAI_BASE_URL = "";
    const fetchMock = stubFetchOk({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("parses tool_calls into NormalizedToolUseBlocks with JSON-parsed input", async () => {
    stubFetchOk({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_a",
                type: "function",
                function: {
                  name: "launch_chrome",
                  arguments: JSON.stringify({ headless: true }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.content).toEqual([
      { type: "tool_use", id: "call_a", name: "launch_chrome", input: { headless: true } },
    ]);
  });

  it("does NOT populate _rawAnthropicContent (other vendors leave it undefined)", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp._rawAnthropicContent).toBeUndefined();
  });

  it("throws on a non-2xx response with status info in the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"error":"invalid_api_key"}',
      json: async () => ({}),
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/401 Unauthorized/);
  });

  it("throws a clear error when OPENAI_API_KEY is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => makeOpenaiAdapter()).toThrow(/OPENAI_API_KEY/);
  });

  it("throws a clear error when EVAL_OPENAI_MODEL is missing", () => {
    delete process.env.EVAL_OPENAI_MODEL;
    expect(() => makeOpenaiAdapter()).toThrow(/EVAL_OPENAI_MODEL/);
  });

  // #63: retry/backoff wrap. The OpenAI adapter has no SDK-internal
  // retry shield (raw fetch); these tests prove a transient blip is
  // recoverable and emits one `onRetry` per retried attempt.
  it("retries once on TypeError('fetch failed') then succeeds, emits one onRetry", async () => {
    const goodBody = {
      id: "chatcmpl-recovered",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(goodBody),
        json: async () => goodBody,
      });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("chatcmpl-recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].attempt).toBe(1);
  }, 10_000);

  it("retries on 500 then succeeds", async () => {
    const goodBody = {
      id: "chatcmpl-recovered",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "boom",
        json: async () => ({}),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(goodBody),
        json: async () => goodBody,
      });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("chatcmpl-recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("does NOT retry on 4xx (401)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "bad key",
      json: async () => ({}),
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    await expect(
      makeOpenaiAdapter().messages({ system: SYSTEM, messages: MESSAGES, onRetry }),
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // #63 review (PR #65, Codex/GPT-5 #1): real 429 cooldowns arrive as
  // response headers. Before the review fix the thrown error dropped
  // them, so withRetry's classifier fell back to jittered exponential
  // backoff (~500–1500ms) instead of the vendor-requested delay.
  // Verify that on a 429 with `Retry-After: 1`, the realized backoff
  // is exactly 1000 ms.
  it("honors real Retry-After header on 429 (1s exactly, not jitter)", async () => {
    const goodBody = {
      id: "chatcmpl-recovered",
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => "rate limited",
        json: async () => ({}),
        headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "1" : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(goodBody),
        json: async () => goodBody,
        headers: { get: () => null },
      });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const resp = await makeOpenaiAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("chatcmpl-recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Retry-After: 1s → backoffMs must be exactly 1000 (not jittered
    // exponential which would be 500–1500ms but rarely exactly 1000).
    expect(onRetry.mock.calls[0]![0].backoffMs).toBe(1000);
  }, 10_000);
});
