import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageParam } from "./anthropic.js";
import type { VendorMessageRequest } from "./vendor.js";
import {
  buildResponsesRequest,
  makeOpenaiResponsesAdapter,
  tierToResponsesEffort,
} from "./openai-responses-adapter.js";

const SYSTEM = "test-system";
const MESSAGES: VendorMessageRequest["messages"] = [
  { role: "user", content: "hello" },
];
const TOOLS: NonNullable<VendorMessageRequest["tools"]> = [
  {
    name: "launch_chrome",
    description: "Launch the browser",
    input_schema: { type: "object", properties: { headless: { type: "boolean" } } },
  },
];

describe("tierToResponsesEffort", () => {
  it("passes through low / medium / high / xhigh (GPT-5.5's four-level enum)", () => {
    expect(tierToResponsesEffort("low")).toBe("low");
    expect(tierToResponsesEffort("medium")).toBe("medium");
    expect(tierToResponsesEffort("high")).toBe("high");
    expect(tierToResponsesEffort("xhigh")).toBe("xhigh");
  });

  it("clamps max down to xhigh (OpenAI's top tier)", () => {
    expect(tierToResponsesEffort("max")).toBe("xhigh");
  });
});

describe("buildResponsesRequest — basic shape", () => {
  it("emits system as the first input item with input_text content", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(req.input[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: SYSTEM }],
    });
  });

  it("emits string-content user messages as input_text items", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: "",
      messages: [{ role: "user", content: "hi there" }],
    });
    expect(req.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi there" }],
      },
    ]);
  });

  it("emits tools in the flat Responses shape (NOT the nested Chat Completions shape)", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(req.tools).toEqual([
      {
        type: "function",
        name: "launch_chrome",
        description: "Launch the browser",
        parameters: { type: "object", properties: { headless: { type: "boolean" } } },
      },
    ]);
    // Negative assertion: no nested `function: {...}` wrapper.
    expect((req.tools![0] as unknown as Record<string, unknown>).function).toBeUndefined();
  });

  it("sets reasoning.effort + reasoning.summary='auto' + include encrypted_content when thinking is on", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "medium" },
    });
    expect(req.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(req.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("omits reasoning + include when thinking is off (non-reasoning trial)", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(req.reasoning).toBeUndefined();
    expect(req.include).toBeUndefined();
  });

  it("sets store: false (stateless round-trip via encrypted_content)", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "high" },
    });
    expect(req.store).toBe(false);
  });

  it("uses max_output_tokens (Responses field name), sized per-tier when thinking is on", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "high" },
    });
    expect(req.max_output_tokens).toBe(32768 + 4096);
  });

  it("clamps max → xhigh in the request body", () => {
    const req = buildResponsesRequest("gpt-5.5", {
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "max" },
    });
    expect(req.reasoning?.effort).toBe("xhigh");
  });
});

describe("buildResponsesRequest — assistant-turn replay (round-trip)", () => {
  it("emits assistant text as a top-level message item with output_text content", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    // [user, assistant-message]
    expect(req.input[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    });
  });

  it("emits assistant tool_use blocks as top-level function_call items with call_id", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "click X" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_abc",
            name: "click",
            input: { selector: "#go" },
          },
        ] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    const fc = req.input[1];
    expect(fc?.type).toBe("function_call");
    expect(fc?.call_id).toBe("call_abc");
    expect(fc?.name).toBe("click");
    expect(fc?.arguments).toBe(JSON.stringify({ selector: "#go" }));
    // Per the cookbook reasoning-items example, the response's
    // item-level `id` (fc_...) is NOT preserved on
    // NormalizedToolUseBlock — replay items omit `id`.
    expect((fc as unknown as Record<string, unknown>).id).toBeUndefined();
  });

  it("round-trips OpenAI thinking blocks as reasoning items with summary + encrypted_content", () => {
    // Per the paid smoke 2026-05-18, the Responses API rejects reasoning
    // input items without a `summary` field. Echo the thinking text
    // back as a summary_text entry to keep the round-trip valid.
    const messages: MessageParam[] = [
      { role: "user", content: "think then act" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "openai",
            thinking: "I'll set a breakpoint first.",
            itemId: "rs_42",
            encryptedContent: "ENCRYPTED-BLOB",
          },
          { type: "text", text: "ok" },
        ] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    const reasoning = req.input[1];
    expect(reasoning).toEqual({
      type: "reasoning",
      id: "rs_42",
      summary: [{ type: "summary_text", text: "I'll set a breakpoint first." }],
      encrypted_content: "ENCRYPTED-BLOB",
    });
  });

  it("emits reasoning items with empty summary[] when the thinking text is empty (API requires the field)", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "openai",
            thinking: "",
            itemId: "rs_99",
          },
        ] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    expect(req.input[0]).toEqual({
      type: "reasoning",
      id: "rs_99",
      summary: [],
    });
  });

  it("emits reasoning items WITHOUT encrypted_content when the field is absent (e.g. if include were dropped)", () => {
    // Realistic path: an operator who unsets the `include` parameter,
    // or a future API change that denies encrypted_content. The
    // adapter should still emit a valid reasoning input item with
    // the summary echo — graceful degradation, NOT a thrown error.
    // PR #61 review (Claude) flagged this case as untested.
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            vendor: "openai",
            thinking: "I have a plan.",
            itemId: "rs_55",
            // encryptedContent intentionally omitted.
          },
        ] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    expect(req.input[0]).toEqual({
      type: "reasoning",
      id: "rs_55",
      summary: [{ type: "summary_text", text: "I have a plan." }],
    });
    // Critical negative assertion: no encrypted_content field at all
    // (vs an empty-string fallback). The Responses API would 400 on
    // an `encrypted_content: ""` field — empirically validated by
    // the same paid-smoke loop that caught the missing-summary issue.
    expect(
      (req.input[0] as unknown as Record<string, unknown>).encrypted_content,
    ).toBeUndefined();
  });

  it("fans out user tool_result blocks into top-level function_call_output items", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_abc",
            content: "ok",
          },
          {
            type: "tool_result",
            tool_use_id: "call_xyz",
            content: { ok: true },
          },
        ] as unknown as MessageParam["content"],
      },
    ];
    const req = buildResponsesRequest("gpt-5.5", { system: "", messages });
    expect(req.input).toEqual([
      { type: "function_call_output", call_id: "call_abc", output: "ok" },
      {
        type: "function_call_output",
        call_id: "call_xyz",
        output: JSON.stringify({ ok: true }),
      },
    ]);
  });
});

describe("makeOpenaiResponsesAdapter — end-to-end via mocked fetch", () => {
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
    const adapter = makeOpenaiResponsesAdapter();
    expect(adapter.vendor).toBe("openai");
    expect(adapter.model).toBe("gpt-5.5");
  });

  it("POSTs to /v1/responses (not /v1/chat/completions)", async () => {
    const fetchMock = stubFetchOk({
      id: "resp_1",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
  });

  it("parses a reasoning + message + function_call output into NormalizedMessage content", async () => {
    stubFetchOk({
      id: "resp_42",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_xyz",
          summary: [
            { type: "summary_text", text: "Plan: set breakpoint then click." },
          ],
          encrypted_content: "ENC-BLOB",
        },
        {
          type: "function_call",
          id: "fc_qqq",
          call_id: "call_99",
          name: "launch_chrome",
          arguments: JSON.stringify({ headless: true }),
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "launching..." }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "medium" },
    });

    expect(resp.id).toBe("resp_42");
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage.inputTokens).toBe(100);
    expect(resp.usage.outputTokens).toBe(50);
    expect(resp.usage.cacheTokens).toEqual({ cachedTokens: 30 });

    // Content order: reasoning → tool_use → text.
    expect(resp.content[0]).toEqual({
      type: "thinking",
      vendor: "openai",
      thinking: "Plan: set breakpoint then click.",
      itemId: "rs_xyz",
      encryptedContent: "ENC-BLOB",
    });
    expect(resp.content[1]).toEqual({
      type: "tool_use",
      id: "call_99", // call_id used; fc_ id intentionally not preserved
      name: "launch_chrome",
      input: { headless: true },
    });
    expect(resp.content[2]).toEqual({ type: "text", text: "launching..." });
  });

  it("does NOT populate _rawAnthropicContent (Responses owns its own replay shape)", async () => {
    stubFetchOk({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp._rawAnthropicContent).toBeUndefined();
  });

  it("leaves cacheTokens undefined when input_tokens_details is absent", async () => {
    stubFetchOk({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.usage.cacheTokens).toBeUndefined();
  });

  it("warns to stderr when prompt > 272K (long-context trip)", async () => {
    stubFetchOk({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: { input_tokens: 272_001, output_tokens: 1 },
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES });
    const warned = errSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("long-context"));
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });

  it("treats concatenated summary_text blocks as one thinking string (newline-joined)", async () => {
    stubFetchOk({
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "first thought" },
            { type: "summary_text", text: "second thought" },
          ],
          encrypted_content: "BLOB",
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      thinking: { tier: "medium" },
    });
    const block = resp.content[0];
    expect(block && block.type === "thinking" ? block.thinking : "").toBe(
      "first thought\nsecond thought",
    );
  });

  it("throws on non-2xx response with status info in the message", async () => {
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
      makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/401 Unauthorized/);
  });

  it("maps status='incomplete' + reason='max_output_tokens' to stopReason='max_tokens' (PR #61 review)", async () => {
    // The Responses API returns HTTP 200 with status="incomplete" when
    // generation hits max_output_tokens. Without this branch the
    // runner would treat the truncated response as a normal end_turn
    // and append potentially-empty assistant text as the final answer.
    stubFetchOk({
      id: "resp_inc",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "partial..." }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20480 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.stopReason).toBe("max_tokens");
    expect(resp.content[0]).toEqual({ type: "text", text: "partial..." });
  });

  it("maps status='incomplete' + other reason (e.g. content_filter) to stopReason='other'", async () => {
    stubFetchOk({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "redacted" }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.stopReason).toBe("other");
  });

  it("status='incomplete' does NOT override stopReason='tool_use' (the function_call still happened)", async () => {
    // A response that produced a function_call before hitting the cap
    // should still drive the runner's tool-execution path; only the
    // happy-path "end_turn" gets overridden to "max_tokens". The
    // truncation cost is accounted for in the next turn's transcript
    // when the tool result comes back.
    stubFetchOk({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "function_call",
          id: "fc_x",
          call_id: "call_x",
          name: "launch_chrome",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20480 },
    });
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp.stopReason).toBe("tool_use");
  });

  it("throws on status='failed' rather than normalizing a failed turn as successful", async () => {
    stubFetchOk({
      id: "resp_failed",
      status: "failed",
      error: { message: "model overloaded", type: "server_error", code: "rate_limit" },
      output: [],
    });
    await expect(
      makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/status=failed/);
    await expect(
      makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/model overloaded/);
  });

  it("throws on status='cancelled'", async () => {
    stubFetchOk({
      status: "cancelled",
      output: [],
    });
    await expect(
      makeOpenaiResponsesAdapter().messages({ system: SYSTEM, messages: MESSAGES }),
    ).rejects.toThrow(/status=cancelled/);
  });

  it("throws a clear error when OPENAI_API_KEY is missing", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => makeOpenaiResponsesAdapter()).toThrow(/OPENAI_API_KEY/);
  });

  it("throws a clear error when EVAL_OPENAI_MODEL is missing", () => {
    delete process.env.EVAL_OPENAI_MODEL;
    expect(() => makeOpenaiResponsesAdapter()).toThrow(/EVAL_OPENAI_MODEL/);
  });

  // #63: retry/backoff wrap. Mirrors the Chat Completions adapter
  // tests; one shape per outcome (transient recovery / 5xx recovery /
  // failed-status no-retry).
  it("retries once on TypeError('fetch failed') then succeeds", async () => {
    const goodBody = {
      id: "resp_recovered",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
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
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("resp_recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("retries on 503 then succeeds", async () => {
    const goodBody = {
      id: "resp_recovered",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
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
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("resp_recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("does NOT retry on status='failed' body (model-side, not transient)", async () => {
    // translateResponse() throws a generic
    //   Error('OpenAI Responses request returned status=failed: …')
    // which doesn't match the HTTP-status pattern; classifier defaults
    // to retry=false. That's correct — a model-side decision to abandon
    // isn't transient.
    const body = {
      id: "resp_failed",
      status: "failed",
      error: { message: "model overloaded", type: "server_error", code: "rate_limit" },
      output: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();
    await expect(
      makeOpenaiResponsesAdapter().messages({
        system: SYSTEM,
        messages: MESSAGES,
        onRetry,
      }),
    ).rejects.toThrow(/status=failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  // #63 review (PR #65, Codex/GPT-5 #1) — see openai-adapter.test.ts
  // for rationale. Mirrors the Chat Completions Retry-After test.
  it("honors real Retry-After header on 429 (1s exactly, not jitter)", async () => {
    const goodBody = {
      id: "resp_recovered",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
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
    const resp = await makeOpenaiResponsesAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("resp_recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].backoffMs).toBe(1000);
  }, 10_000);
});
