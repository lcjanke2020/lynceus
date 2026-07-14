import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorMessageRequest } from "./vendor.js";
import { makeDeepseekAdapter } from "./deepseek-adapter.js";

// DeepSeek + Moonshot share the openai-compat-adapter factory; this file
// exercises the factory thoroughly via the DeepSeek wrapper. moonshot-adapter
// .test.ts covers the per-vendor identity (vendor tag, default base URL, env).

const SYSTEM = "test-system";
const MESSAGES: VendorMessageRequest["messages"] = [
  { role: "user", content: "hello" },
];
const TOOLS: NonNullable<VendorMessageRequest["tools"]> = [
  { name: "noop", input_schema: { type: "object" } },
];

const OK_BODY = {
  id: "ds-1",
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

describe("makeDeepseekAdapter — OpenAI-compat via mocked fetch", () => {
  const saved = {
    key: process.env.EVAL_DEEPSEEK_API_KEY,
    model: process.env.EVAL_DEEPSEEK_MODEL,
    base: process.env.EVAL_DEEPSEEK_BASE_URL,
    maxTok: process.env.EVAL_DEEPSEEK_MAX_TOKENS,
    effort: process.env.EVAL_DEEPSEEK_REASONING_EFFORT,
  };

  beforeEach(() => {
    process.env.EVAL_DEEPSEEK_API_KEY = "test-key";
    process.env.EVAL_DEEPSEEK_MODEL = "deepseek-v4-pro";
    delete process.env.EVAL_DEEPSEEK_BASE_URL;
    delete process.env.EVAL_DEEPSEEK_MAX_TOKENS;
    delete process.env.EVAL_DEEPSEEK_REASONING_EFFORT;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    for (const [k, v] of [
      ["EVAL_DEEPSEEK_API_KEY", saved.key],
      ["EVAL_DEEPSEEK_MODEL", saved.model],
      ["EVAL_DEEPSEEK_BASE_URL", saved.base],
      ["EVAL_DEEPSEEK_MAX_TOKENS", saved.maxTok],
      ["EVAL_DEEPSEEK_REASONING_EFFORT", saved.effort],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
  });

  function stubFetchOk(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("populates vendor + model identity from env", () => {
    const a = makeDeepseekAdapter();
    expect(a.vendor).toBe("deepseek");
    expect(a.model).toBe("deepseek-v4-pro");
  });

  it("posts to the default base URL with bearer auth + JSON content type", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("honors EVAL_DEEPSEEK_BASE_URL and strips a trailing slash", async () => {
    process.env.EVAL_DEEPSEEK_BASE_URL = "https://example.invalid/v1/";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://example.invalid/v1/chat/completions",
    );
  });

  it("treats EVAL_DEEPSEEK_BASE_URL='' as unset (falls back to default)", async () => {
    process.env.EVAL_DEEPSEEK_BASE_URL = "";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("sends max_tokens (NOT max_completion_tokens), tools + tool_choice, temperature passthrough", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      temperature: 0.7,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.model).toBe("deepseek-v4-pro");
    // GH #7: default per-request output cap is 32K (covers reasoning + answer),
    // not the old 4096 that truncated thinking models.
    expect(body.max_tokens).toBe(32_768);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.7);
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toHaveLength(1);
  });

  it("turns reasoning on via the thinking toggle + top-level reasoning_effort (GH #8)", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    // DeepSeek V4 thinking-mode shape: `thinking` toggle enables it, effort is
    // the TOP-LEVEL `reasoning_effort` field. `high` for explicit always-on.
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("uses caller-supplied maxTokens", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      maxTokens: 1234,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(1234);
  });

  it("omits tools + tool_choice when none supplied", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
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
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.content).toEqual([
      { type: "tool_use", id: "call_a", name: "launch_chrome", input: { headless: true } },
    ]);
  });

  it("surfaces reasoning_content as a deepseek thinking block (response capture side, GH #8)", async () => {
    stubFetchOk({
      id: "ds-r",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "let me think…",
            tool_calls: [
              { id: "call_d", type: "function", function: { name: "noop", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.content[0]).toEqual({
      type: "thinking",
      vendor: "deepseek",
      thinking: "let me think…",
    });
    expect(resp.stopReason).toBe("tool_use");
  });

  it("bills cache from prompt_cache_hit_tokens (GH #8)", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "x" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
      },
    });
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    // DeepSeek reports cache hits top-level (NOT prompt_tokens_details); the
    // adapter normalizes it to `cachedTokens`. `prompt_tokens` includes the
    // cached portion — estimateCostUsd subtracts it before billing fresh input.
    expect(resp.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheTokens: { cachedTokens: 700 },
    });
  });

  it("leaves cacheTokens undefined when there is no cache hit", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "x" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1000,
      },
    });
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.usage.cacheTokens).toBeUndefined();
    expect(resp.usage).toEqual({ inputTokens: 1000, outputTokens: 50 });
  });

  it("vendor-tags the response id when the API omits one", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.id).toMatch(/^deepseek-/);
  });

  it("does NOT populate _rawAnthropicContent", async () => {
    stubFetchOk(OK_BODY);
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp._rawAnthropicContent).toBeUndefined();
  });

  it("throws on a non-2xx response with the vendor label + status in the message", async () => {
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
      makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/DeepSeek request failed: 401 Unauthorized/);
  });

  it("throws when EVAL_DEEPSEEK_API_KEY is missing", () => {
    delete process.env.EVAL_DEEPSEEK_API_KEY;
    expect(() => makeDeepseekAdapter()).toThrow(/EVAL_DEEPSEEK_API_KEY/);
  });

  it("throws when EVAL_DEEPSEEK_MODEL is missing", () => {
    delete process.env.EVAL_DEEPSEEK_MODEL;
    expect(() => makeDeepseekAdapter()).toThrow(/EVAL_DEEPSEEK_MODEL/);
  });

  // Pre-flight pricing validation (GH #8 review): an unknown model id must
  // throw at construction — BEFORE any billable request — not later in
  // estimateCostUsd after the first paid call. No fetch should be issued.
  it("throws at construction (no fetch) for a model with no pricing row", () => {
    process.env.EVAL_DEEPSEEK_MODEL = "deepseek-vNN-imaginary";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeDeepseekAdapter()).toThrow(/No pricing row for \(deepseek/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // withRetry wrap (#63): a 500 must be recoverable and emit one onRetry. Also
  // proves the thrown error shape ("… request failed: 500 …") is classified as
  // retryable by with-retry's status extractor.
  it("retries on 500 then succeeds, emitting one onRetry", async () => {
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
        text: async () => JSON.stringify(OK_BODY),
        json: async () => OK_BODY,
        headers: { get: () => null },
      });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    const resp = await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("ds-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 10_000);

  // GH #7 env knobs (extracted from draft PR #28), factory-thorough side:
  // output-cap precedence chain + reasoning-effort override + construction-time
  // validation (fail BEFORE any billable request, like the pricing preflight).

  it("EVAL_DEEPSEEK_MAX_TOKENS overrides the 32K default (GH #7)", async () => {
    process.env.EVAL_DEEPSEEK_MAX_TOKENS = "8192";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(8192);
  });

  it("explicit req.maxTokens beats EVAL_DEEPSEEK_MAX_TOKENS", async () => {
    process.env.EVAL_DEEPSEEK_MAX_TOKENS = "8192";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      maxTokens: 1234,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(1234);
  });

  it("treats EVAL_DEEPSEEK_MAX_TOKENS='' as unset (32K default stands)", async () => {
    process.env.EVAL_DEEPSEEK_MAX_TOKENS = "";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(32_768);
  });

  it("throws at construction (no fetch) on a non-integer EVAL_DEEPSEEK_MAX_TOKENS", () => {
    process.env.EVAL_DEEPSEEK_MAX_TOKENS = "16k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeDeepseekAdapter()).toThrow(
      /EVAL_DEEPSEEK_MAX_TOKENS='16k' is not a positive integer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws at construction on a non-positive EVAL_DEEPSEEK_MAX_TOKENS", () => {
    process.env.EVAL_DEEPSEEK_MAX_TOKENS = "0";
    expect(() => makeDeepseekAdapter()).toThrow(/not a positive integer/);
  });

  it("EVAL_DEEPSEEK_REASONING_EFFORT beats the hardcoded 'high' (merged after extraBody, GH #7)", async () => {
    process.env.EVAL_DEEPSEEK_REASONING_EFFORT = "medium";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.reasoning_effort).toBe("medium");
    // The env knob only swaps the effort tier — the thinking toggle stands.
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("treats EVAL_DEEPSEEK_REASONING_EFFORT='' as unset (extraBody 'high' stands)", async () => {
    process.env.EVAL_DEEPSEEK_REASONING_EFFORT = "";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeDeepseekAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.reasoning_effort).toBe("high");
  });

  it("throws at construction (no fetch) on an invalid EVAL_DEEPSEEK_REASONING_EFFORT, listing allowed tiers", () => {
    process.env.EVAL_DEEPSEEK_REASONING_EFFORT = "extreme";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeDeepseekAdapter()).toThrow(
      /low \| medium \| high \| xhigh \| max/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
