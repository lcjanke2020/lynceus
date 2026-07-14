import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorMessageRequest } from "./vendor.js";
import { makeMoonshotAdapter } from "./moonshot-adapter.js";

// The shared openai-compat factory is exercised in depth by
// deepseek-adapter.test.ts; here we pin Moonshot's per-vendor identity:
// vendor tag, the global `.ai` default base URL, env-var names, and that it
// drives the OpenAI-compat request shape (max_tokens, not max_completion_tokens).

const SYSTEM = "test-system";
const MESSAGES: VendorMessageRequest["messages"] = [
  { role: "user", content: "hello" },
];

const OK_BODY = {
  id: "ks-1",
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

describe("makeMoonshotAdapter — OpenAI-compat via mocked fetch", () => {
  const saved = {
    key: process.env.EVAL_MOONSHOT_API_KEY,
    model: process.env.EVAL_MOONSHOT_MODEL,
    base: process.env.EVAL_MOONSHOT_BASE_URL,
    maxTok: process.env.EVAL_MOONSHOT_MAX_TOKENS,
    effort: process.env.EVAL_MOONSHOT_REASONING_EFFORT,
  };

  beforeEach(() => {
    process.env.EVAL_MOONSHOT_API_KEY = "test-key";
    process.env.EVAL_MOONSHOT_MODEL = "kimi-k2.6";
    delete process.env.EVAL_MOONSHOT_BASE_URL;
    delete process.env.EVAL_MOONSHOT_MAX_TOKENS;
    delete process.env.EVAL_MOONSHOT_REASONING_EFFORT;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    for (const [k, v] of [
      ["EVAL_MOONSHOT_API_KEY", saved.key],
      ["EVAL_MOONSHOT_MODEL", saved.model],
      ["EVAL_MOONSHOT_BASE_URL", saved.base],
      ["EVAL_MOONSHOT_MAX_TOKENS", saved.maxTok],
      ["EVAL_MOONSHOT_REASONING_EFFORT", saved.effort],
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
    const a = makeMoonshotAdapter();
    expect(a.vendor).toBe("moonshot");
    expect(a.model).toBe("kimi-k2.6");
  });

  it("posts to the global .ai default base URL with bearer auth, sending max_tokens", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeMoonshotAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("kimi-k2.6");
    // GH #7: default per-request output cap is 32K, not the old 4096.
    expect(body.max_tokens).toBe(32_768);
    expect(body.max_completion_tokens).toBeUndefined();
    // Moonshot reasons by server-side default — no request-side toggle (the
    // `thinking` object is DeepSeek-only).
    expect(body.thinking).toBeUndefined();
  });

  it("vendor-tags the response id when the API omits one", async () => {
    stubFetchOk({
      choices: [
        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const resp = await makeMoonshotAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.id).toMatch(/^moonshot-/);
  });

  it("surfaces reasoning_content as a moonshot thinking block in resp.content", async () => {
    stubFetchOk({
      id: "ks-2",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "thinking…",
            tool_calls: [
              { id: "call_k", type: "function", function: { name: "noop", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const resp = await makeMoonshotAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.content[0]).toEqual({
      type: "thinking",
      vendor: "moonshot",
      thinking: "thinking…",
    });
    expect(resp.stopReason).toBe("tool_use");
  });

  it("bills cache from prompt_tokens_details.cached_tokens (GH #8)", async () => {
    stubFetchOk({
      id: "ks-c",
      choices: [
        { message: { role: "assistant", content: "x" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 500 },
      },
    });
    const resp = await makeMoonshotAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    // Moonshot reports cache hits OpenAI-style (nested), unlike DeepSeek's
    // top-level field; the adapter normalizes both to `cachedTokens`.
    expect(resp.usage).toEqual({
      inputTokens: 800,
      outputTokens: 20,
      cacheTokens: { cachedTokens: 500 },
    });
  });

  it("throws when EVAL_MOONSHOT_API_KEY is missing", () => {
    delete process.env.EVAL_MOONSHOT_API_KEY;
    expect(() => makeMoonshotAdapter()).toThrow(/EVAL_MOONSHOT_API_KEY/);
  });

  it("throws when EVAL_MOONSHOT_MODEL is missing", () => {
    delete process.env.EVAL_MOONSHOT_MODEL;
    expect(() => makeMoonshotAdapter()).toThrow(/EVAL_MOONSHOT_MODEL/);
  });

  // Parity with the DeepSeek suite: prove the "Moonshot request failed: 5xx"
  // error shape is classified as retryable by with-retry, independent of any
  // future factory refactor (kimi review).
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
    const resp = await makeMoonshotAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("ks-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 10_000);

  // GH #7 knobs, Moonshot side: the output-cap env is wired; a reasoning-effort
  // env is deliberately NOT (Kimi has no request-side effort param).

  it("EVAL_MOONSHOT_MAX_TOKENS overrides the 32K default (GH #7)", async () => {
    process.env.EVAL_MOONSHOT_MAX_TOKENS = "65536";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeMoonshotAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(65_536);
  });

  it("ignores EVAL_MOONSHOT_REASONING_EFFORT — no request-side effort param on Kimi", async () => {
    process.env.EVAL_MOONSHOT_REASONING_EFFORT = "high";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeMoonshotAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.reasoning_effort).toBeUndefined();
  });
});
