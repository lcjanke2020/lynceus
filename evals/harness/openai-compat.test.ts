import { describe, expect, it } from "vitest";
import type { MessageParam, Tool } from "./anthropic.js";
import {
  mapFinishReason,
  translateMessages,
  translateResponse,
  translateTools,
  type OpenAIChatResponse,
} from "./openai-compat.js";

describe("translateMessages", () => {
  it("emits a system message when system is a non-empty string", () => {
    const out = translateMessages("rules", []);
    expect(out).toEqual([{ role: "system", content: "rules" }]);
  });

  it("flattens TextBlock[] system into a single system message", () => {
    const out = translateMessages(
      [
        { type: "text", text: "rule 1" },
        { type: "text", text: "rule 2" },
      ],
      [],
    );
    expect(out).toEqual([{ role: "system", content: "rule 1\n\nrule 2" }]);
  });

  it("omits a system message when system text is empty", () => {
    expect(translateMessages("", [])).toEqual([]);
    expect(translateMessages([], [])).toEqual([]);
  });

  it("passes through user messages with string content", () => {
    const out = translateMessages("", [{ role: "user", content: "hello" }]);
    expect(out).toEqual([{ role: "user", content: "hello" }]);
  });

  it("folds assistant text + tool_use blocks into one OpenAI message with tool_calls", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Launching " },
          {
            type: "tool_use",
            id: "tu_1",
            name: "launch_chrome",
            input: { headless: true },
          },
          { type: "text", text: "now." },
        ] as unknown as MessageParam["content"],
      },
    ];
    const out = translateMessages("", messages);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "Launching now.",
        tool_calls: [
          {
            id: "tu_1",
            type: "function",
            function: {
              name: "launch_chrome",
              arguments: JSON.stringify({ headless: true }),
            },
          },
        ],
      },
    ]);
  });

  it("emits content:null when assistant turn has only tool_use blocks (no text)", () => {
    const out = translateMessages("", [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "x", input: {} },
        ] as unknown as MessageParam["content"],
      },
    ]);
    expect(out[0]!.content).toBeNull();
    expect(out[0]!.tool_calls).toHaveLength(1);
  });

  it("drops thinking + redacted_thinking blocks on assistant turns", () => {
    // OpenAI Chat Completions does not round-trip Anthropic-signed
    // thinking blocks. Translation must silently drop them.
    const out = translateMessages("", [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ignored", signature: "sig" },
          { type: "redacted_thinking", data: "blob" },
          { type: "text", text: "kept" },
        ] as unknown as MessageParam["content"],
      },
    ]);
    expect(out).toEqual([{ role: "assistant", content: "kept" }]);
  });

  it("re-emits a moonshot thinking block as reasoning_content (keeps tool_calls; still drops other thinking)", () => {
    const out = translateMessages("", [
      {
        role: "assistant",
        content: [
          { type: "thinking", vendor: "moonshot", thinking: "k2 chain-of-thought" },
          { type: "thinking", thinking: "anthropic-signed", signature: "sig" },
          { type: "text", text: "calling a tool" },
          { type: "tool_use", id: "call_k", name: "noop", input: { a: 1 } },
        ] as unknown as MessageParam["content"],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.content).toBe("calling a tool");
    expect(out[0]!.reasoning_content).toBe("k2 chain-of-thought");
    expect(out[0]!.tool_calls).toEqual([
      {
        id: "call_k",
        type: "function",
        function: { name: "noop", arguments: JSON.stringify({ a: 1 }) },
      },
    ]);
  });

  it("re-emits a deepseek thinking block as reasoning_content (GH #8 — same as moonshot)", () => {
    // DeepSeek V4 thinking mode requires reasoning_content echoed back on
    // tool-call turns (verified vs the live API) — NOT the mirror opposite the
    // old deepseek-reasoner guide described. So a deepseek-tagged block is
    // re-emitted, exactly like moonshot.
    const out = translateMessages("", [
      {
        role: "assistant",
        content: [
          { type: "thinking", vendor: "deepseek", thinking: "deepseek cot" },
          { type: "text", text: "calling a tool" },
          { type: "tool_use", id: "call_d", name: "noop", input: { a: 1 } },
        ] as unknown as MessageParam["content"],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("calling a tool");
    expect(out[0]!.reasoning_content).toBe("deepseek cot");
    expect(out[0]!.tool_calls).toEqual([
      {
        id: "call_d",
        type: "function",
        function: { name: "noop", arguments: JSON.stringify({ a: 1 }) },
      },
    ]);
  });

  it("fans out user tool_result blocks into separate role:tool messages", () => {
    const out = translateMessages("", [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_a",
            content: "result-a",
          },
          {
            type: "tool_result",
            tool_use_id: "tu_b",
            content: { ok: true },
          },
          { type: "text", text: "plus a comment" },
        ] as unknown as MessageParam["content"],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "tu_a", content: "result-a" },
      { role: "tool", tool_call_id: "tu_b", content: JSON.stringify({ ok: true }) },
      { role: "user", content: "plus a comment" },
    ]);
  });
});

describe("translateTools", () => {
  it("translates Anthropic Tool to OpenAI function descriptor", () => {
    const tools: Tool[] = [
      {
        name: "launch_chrome",
        description: "Launch the browser.",
        input_schema: { type: "object", properties: { headless: { type: "boolean" } } },
      } as Tool,
    ];
    expect(translateTools(tools)).toEqual([
      {
        type: "function",
        function: {
          name: "launch_chrome",
          description: "Launch the browser.",
          parameters: {
            type: "object",
            properties: { headless: { type: "boolean" } },
          },
        },
      },
    ]);
  });

  it("drops cache_control from the last tool (Anthropic prompt-cache marker)", () => {
    const tools = [
      {
        name: "noop",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ] as unknown as Tool[];
    const out = translateTools(tools);
    expect(out[0]).toEqual({
      type: "function",
      function: {
        name: "noop",
        description: "",
        parameters: { type: "object" },
      },
    });
    expect("cache_control" in (out[0] as object)).toBe(false);
  });

  it("defaults description to empty string when omitted", () => {
    const tools: Tool[] = [
      { name: "x", input_schema: { type: "object" } } as Tool,
    ];
    expect(translateTools(tools)[0]!.function.description).toBe("");
  });
});

describe("translateResponse", () => {
  function mkResp(over: Partial<OpenAIChatResponse> = {}): OpenAIChatResponse {
    return {
      id: "chatcmpl-1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "hello",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
      ...over,
    };
  }

  it("emits a single TextBlock when only content text is present", () => {
    const out = translateResponse(mkResp(), "openai");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stopReason).toBe("end_turn");
    expect(out.id).toBe("chatcmpl-1");
    expect(out.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it("captures Moonshot reasoning_content as a moonshot thinking block (idPrefix=moonshot)", () => {
    const out = translateResponse(
      mkResp({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "let me think…",
              tool_calls: [
                {
                  id: "call_k",
                  type: "function",
                  function: { name: "launch_chrome", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "moonshot",
    );
    // Thinking block first, then the tool_use — so the runner re-feeds it on
    // the next assistant turn (K2 Thinking requires reasoning_content echoed).
    expect(out.content).toEqual([
      { type: "thinking", vendor: "moonshot", thinking: "let me think…" },
      { type: "tool_use", id: "call_k", name: "launch_chrome", input: {} },
    ]);
    expect(out.stopReason).toBe("tool_use");
  });

  it("captures DeepSeek reasoning_content as a deepseek thinking block (idPrefix=deepseek, GH #8)", () => {
    const resp = mkResp({
      choices: [
        {
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "deepseek cot",
          },
          finish_reason: "stop",
        },
      ],
    });
    expect(translateResponse(resp, "deepseek").content).toEqual([
      { type: "thinking", vendor: "deepseek", thinking: "deepseek cot" },
      { type: "text", text: "answer" },
    ]);
  });

  it("ignores reasoning_content for non-reasoning vendors (openai, lm-studio)", () => {
    const resp = mkResp({
      choices: [
        {
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "should be ignored",
          },
          finish_reason: "stop",
        },
      ],
    });
    expect(translateResponse(resp, "openai").content).toEqual([
      { type: "text", text: "answer" },
    ]);
    expect(translateResponse(resp, "lm-studio").content).toEqual([
      { type: "text", text: "answer" },
    ]);
  });

  it("emits tool_use blocks with JSON-parsed arguments", () => {
    const out = translateResponse(
      mkResp({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "launch_chrome", arguments: JSON.stringify({ headless: true }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "openai",
    );
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_x", name: "launch_chrome", input: { headless: true } },
    ]);
    expect(out.stopReason).toBe("tool_use");
  });

  it("falls back to {_raw} when tool_call arguments fail to parse", () => {
    const out = translateResponse(
      mkResp({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_y",
                  type: "function",
                  function: { name: "x", arguments: "not-json{{" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      "openai",
    );
    expect(out.content[0]).toEqual({
      type: "tool_use",
      id: "call_y",
      name: "x",
      input: { _raw: "not-json{{" },
    });
  });

  it("synthesizes an id when the response omits one (uses prefix)", () => {
    const out = translateResponse(mkResp({ id: undefined }), "openai");
    expect(out.id).toMatch(/^openai-/);
  });

  it("calls the cacheTokensFrom extractor and surfaces its result", () => {
    const out = translateResponse(
      mkResp({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      }),
      "openai",
      (usage) =>
        usage?.prompt_tokens_details?.cached_tokens
          ? { cachedTokens: usage.prompt_tokens_details.cached_tokens }
          : undefined,
    );
    expect(out.usage.cacheTokens).toEqual({ cachedTokens: 30 });
  });

  it("omits cacheTokens when the extractor returns an empty map", () => {
    // Defensive: the runner reads absent as "no cache activity"; an
    // empty map would round-trip through the trace as `cacheTokens: {}`,
    // which is harmless but noisier.
    const out = translateResponse(mkResp(), "openai", () => ({}));
    expect(out.usage.cacheTokens).toBeUndefined();
  });

  it("omits cacheTokens when no extractor is supplied (LM Studio path)", () => {
    const out = translateResponse(mkResp(), "lm-studio");
    expect(out.usage.cacheTokens).toBeUndefined();
  });

  it("throws on a choices-less response", () => {
    expect(() =>
      translateResponse({ choices: [] } as OpenAIChatResponse, "openai"),
    ).toThrow(/no choices/);
  });
});

describe("mapFinishReason", () => {
  it("maps stop → end_turn", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
  });
  it("maps length → max_tokens", () => {
    expect(mapFinishReason("length")).toBe("max_tokens");
  });
  it("maps tool_calls and function_call → tool_use", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("function_call")).toBe("tool_use");
  });
  it("maps unknown values → other", () => {
    expect(mapFinishReason("content_filter")).toBe("other");
    expect(mapFinishReason("")).toBe("other");
  });
});
