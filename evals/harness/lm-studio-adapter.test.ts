import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VendorMessageRequest } from "./vendor.js";
import { makeLmStudioAdapter } from "./lm-studio-adapter.js";
import { makeOpenAICompatAdapter } from "./openai-compat-adapter.js";

// The shared openai-compat factory is exercised in depth by
// deepseek-adapter.test.ts; here we pin LM Studio's per-vendor identity AND
// the guarantees the GH #7 factory migration must preserve from the old
// standalone adapter: required BASE_URL/MODEL/API_KEY (no default base URL),
// the historical 4096 output-cap default, the "LM Studio request failed"
// error shape with-retry keys on, and no cache accounting.

const SYSTEM = "test-system";
const MESSAGES: VendorMessageRequest["messages"] = [
  { role: "user", content: "hello" },
];

const OK_BODY = {
  id: "lms-1",
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

describe("makeLmStudioAdapter — OpenAI-compat via mocked fetch", () => {
  const saved = {
    base: process.env.EVAL_LM_STUDIO_BASE_URL,
    model: process.env.EVAL_LM_STUDIO_MODEL,
    key: process.env.EVAL_LM_STUDIO_API_KEY,
    maxTok: process.env.EVAL_LM_STUDIO_MAX_TOKENS,
    effort: process.env.EVAL_LM_STUDIO_REASONING_EFFORT,
  };

  beforeEach(() => {
    process.env.EVAL_LM_STUDIO_BASE_URL = "http://example.invalid:1234/v1";
    process.env.EVAL_LM_STUDIO_MODEL = "openai/gpt-oss-120b";
    process.env.EVAL_LM_STUDIO_API_KEY = "test-key";
    delete process.env.EVAL_LM_STUDIO_MAX_TOKENS;
    delete process.env.EVAL_LM_STUDIO_REASONING_EFFORT;
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    for (const [k, v] of [
      ["EVAL_LM_STUDIO_BASE_URL", saved.base],
      ["EVAL_LM_STUDIO_MODEL", saved.model],
      ["EVAL_LM_STUDIO_API_KEY", saved.key],
      ["EVAL_LM_STUDIO_MAX_TOKENS", saved.maxTok],
      ["EVAL_LM_STUDIO_REASONING_EFFORT", saved.effort],
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

  it("populates vendor + model identity from env (any model id — '*' $0 pricing wildcard)", () => {
    const a = makeLmStudioAdapter();
    expect(a.vendor).toBe("lm-studio");
    expect(a.model).toBe("openai/gpt-oss-120b");
  });

  it("posts to the env base URL with bearer auth; 4096 parity default; no reasoning_effort unless asked", async () => {
    const fetchMock = stubFetchOk(OK_BODY);
    await makeLmStudioAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://example.invalid:1234/v1/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("openai/gpt-oss-120b");
    // Migration parity: LM Studio keeps its historical 4096 default (via
    // defaultMaxTokens), NOT the factory's 32K remote-reasoning default.
    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("strips a trailing slash from EVAL_LM_STUDIO_BASE_URL", async () => {
    process.env.EVAL_LM_STUDIO_BASE_URL = "http://localhost:1234/v1/";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeLmStudioAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
  });

  it("throws at construction (no fetch) when EVAL_LM_STUDIO_BASE_URL is missing — no default base URL", () => {
    delete process.env.EVAL_LM_STUDIO_BASE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeLmStudioAdapter()).toThrow(/EVAL_LM_STUDIO_BASE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats EVAL_LM_STUDIO_BASE_URL='' as missing (still required)", () => {
    process.env.EVAL_LM_STUDIO_BASE_URL = "";
    expect(() => makeLmStudioAdapter()).toThrow(/EVAL_LM_STUDIO_BASE_URL/);
  });

  it("throws when EVAL_LM_STUDIO_API_KEY is missing", () => {
    delete process.env.EVAL_LM_STUDIO_API_KEY;
    expect(() => makeLmStudioAdapter()).toThrow(/EVAL_LM_STUDIO_API_KEY/);
  });

  it("throws when EVAL_LM_STUDIO_MODEL is missing", () => {
    delete process.env.EVAL_LM_STUDIO_MODEL;
    expect(() => makeLmStudioAdapter()).toThrow(/EVAL_LM_STUDIO_MODEL/);
  });

  it("EVAL_LM_STUDIO_MAX_TOKENS buys output headroom (GH #7, ex-draft #28)", async () => {
    process.env.EVAL_LM_STUDIO_MAX_TOKENS = "8192";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeLmStudioAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(8192);
  });

  it("throws at construction (no fetch) on a malformed EVAL_LM_STUDIO_MAX_TOKENS", () => {
    process.env.EVAL_LM_STUDIO_MAX_TOKENS = "8k";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeLmStudioAdapter()).toThrow(
      /EVAL_LM_STUDIO_MAX_TOKENS='8k' is not a positive integer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explicit req.maxTokens beats EVAL_LM_STUDIO_MAX_TOKENS", async () => {
    process.env.EVAL_LM_STUDIO_MAX_TOKENS = "8192";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeLmStudioAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      maxTokens: 1234,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.max_tokens).toBe(1234);
  });

  it("EVAL_LM_STUDIO_REASONING_EFFORT forwards reasoning_effort (GH #7, ex-draft #28)", async () => {
    process.env.EVAL_LM_STUDIO_REASONING_EFFORT = "medium";
    const fetchMock = stubFetchOk(OK_BODY);
    await makeLmStudioAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.reasoning_effort).toBe("medium");
  });

  it("throws at construction (no fetch) on an invalid EVAL_LM_STUDIO_REASONING_EFFORT", () => {
    process.env.EVAL_LM_STUDIO_REASONING_EFFORT = "maximum";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => makeLmStudioAdapter()).toThrow(
      /low \| medium \| high \| xhigh \| max/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Config-bug guard (Copilot, PR #55): a hardcoded defaultMaxTokens typo in a
  // vendor wrapper must fail at construction like the env knobs do — exercised
  // via the factory directly since the real wrapper pins a valid 4096. Uses the
  // EVAL_LM_STUDIO_* envs this suite already sets.
  it("throws at construction on a non-positive defaultMaxTokens config value", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() =>
      makeOpenAICompatAdapter({
        vendor: "lm-studio",
        label: "LM Studio",
        apiKeyEnv: "EVAL_LM_STUDIO_API_KEY",
        modelEnv: "EVAL_LM_STUDIO_MODEL",
        baseUrlEnv: "EVAL_LM_STUDIO_BASE_URL",
        defaultMaxTokens: 0,
      }),
    ).toThrow(/defaultMaxTokens=0 is not a positive integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the 'LM Studio request failed' error shape with-retry keys on", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"error":"bad key"}',
      json: async () => ({}),
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      makeLmStudioAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/LM Studio request failed: 401 Unauthorized/);
  });

  it("leaves usage.cacheTokens undefined — LM Studio has no cache accounting", async () => {
    stubFetchOk(OK_BODY);
    const resp = await makeLmStudioAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(resp.usage.cacheTokens).toBeUndefined();
  });
});
