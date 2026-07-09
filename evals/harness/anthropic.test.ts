import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitAssistantContent } from "./anthropic.js";
import type { Message } from "@anthropic-ai/sdk/resources/messages.js";
import type { ReasoningTier, VendorMessageRequest } from "./vendor.js";

function makeMessage(content: unknown): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: content as Message["content"],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Message;
}

describe("splitAssistantContent", () => {
  it("extracts text + tool_use, returns empty thinking[] when none present", () => {
    const msg = makeMessage([
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "tu_1", name: "launch_chrome", input: { headless: true } },
      { type: "text", text: "world" },
    ]);
    const { text, toolUses, thinking } = splitAssistantContent(msg);
    expect(text).toBe("Hello world");
    expect(toolUses).toEqual([
      { id: "tu_1", name: "launch_chrome", input: { headless: true } },
    ]);
    expect(thinking).toEqual([]);
  });

  it("captures thinking blocks with signature preserved verbatim", () => {
    const sig = "ErUBCkYI..."; // opaque base64-ish blob from Anthropic
    const msg = makeMessage([
      {
        type: "thinking",
        thinking: "Let me set a breakpoint on line 42 first.",
        signature: sig,
      },
      { type: "text", text: "Setting breakpoint." },
    ]);
    const { text, toolUses, thinking } = splitAssistantContent(msg);
    expect(text).toBe("Setting breakpoint.");
    expect(toolUses).toEqual([]);
    expect(thinking).toEqual([
      {
        type: "thinking",
        thinking: "Let me set a breakpoint on line 42 first.",
        signature: sig,
      },
    ]);
  });

  it("captures redacted_thinking blocks with data preserved verbatim", () => {
    const data = "EncryptedPayloadFromAnthropic==";
    const msg = makeMessage([
      { type: "redacted_thinking", data },
      { type: "text", text: "Continuing." },
    ]);
    const { thinking } = splitAssistantContent(msg);
    expect(thinking).toEqual([{ type: "redacted_thinking", data }]);
  });

  it("preserves multiple thinking blocks in order alongside text and tool_use", () => {
    const msg = makeMessage([
      { type: "thinking", thinking: "first", signature: "sig1" },
      { type: "text", text: "intermediate " },
      { type: "thinking", thinking: "second", signature: "sig2" },
      { type: "tool_use", id: "tu_x", name: "noop", input: {} },
      { type: "text", text: "answer" },
    ]);
    const { text, toolUses, thinking } = splitAssistantContent(msg);
    expect(text).toBe("intermediate answer");
    expect(toolUses).toHaveLength(1);
    expect(thinking).toEqual([
      { type: "thinking", thinking: "first", signature: "sig1" },
      { type: "thinking", thinking: "second", signature: "sig2" },
    ]);
  });

  it("handles missing fields defensively (empty thinking string, empty signature)", () => {
    // Defensive against future SDK changes that might emit partial blocks.
    const msg = makeMessage([
      { type: "thinking" },
      { type: "redacted_thinking" },
    ]);
    const { thinking } = splitAssistantContent(msg);
    expect(thinking).toEqual([
      { type: "thinking", thinking: "", signature: "" },
      { type: "redacted_thinking", data: "" },
    ]);
  });

  it("ignores unknown block types (forward compat)", () => {
    const msg = makeMessage([
      { type: "text", text: "ok" },
      { type: "future_block_type_v9", data: "irrelevant" },
    ]);
    const { text, toolUses, thinking } = splitAssistantContent(msg);
    expect(text).toBe("ok");
    expect(toolUses).toEqual([]);
    expect(thinking).toEqual([]);
  });
});

const SYSTEM = [{ type: "text" as const, text: "system" }];
const MESSAGES: VendorMessageRequest["messages"] = [{ role: "user", content: "hi" }];
const TOOLS: NonNullable<VendorMessageRequest["tools"]> = [
  { name: "noop", input_schema: { type: "object" } },
];

// The `buildAnthropicRequest` tests below pin the model explicitly per
// describe block via EVAL_MODEL_OVERRIDE + vi.resetModules + dynamic
// import, because MODEL_ID / THINKING_STYLE are module-load constants.
// Post-2026-05 the default model is Opus 4.7 (adaptive); the budget-
// style assertions need an explicit Sonnet pin rather than relying on
// "no override = default = Sonnet" — that contract was inverted by the
// default-model swap.
describe("buildAnthropicRequest — budget-style (Sonnet 4.6)", () => {
  const originalOverride = process.env.EVAL_MODEL_OVERRIDE;

  beforeEach(() => {
    process.env.EVAL_MODEL_OVERRIDE = "claude-sonnet-4-6";
    vi.resetModules();
  });
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = originalOverride;
  });

  it("thinking off: temperature=0, maxTokens=4096, no thinking payload", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const { MODEL_ID } = await import("./model.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(req.model).toBe(MODEL_ID);
    expect(req.temperature).toBe(0);
    expect(req.maxTokens).toBe(RESPONSE_HEADROOM_TOKENS);
    expect(req.thinking).toBeUndefined();
    expect(req.system).toBe(SYSTEM);
    expect(req.messages).toBe(MESSAGES);
    expect(req.tools).toBe(TOOLS);
  });

  it("thinking on: temperature=1, maxTokens=budget+headroom, thinking payload set", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "high", budgetTokensOverride: 16384 },
    });
    expect(req.temperature).toBe(1);
    expect(req.maxTokens).toBe(16384 + RESPONSE_HEADROOM_TOKENS);
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  });

  it("budgetTokensOverride wins over the tier-default budget", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "high", budgetTokensOverride: 5000 },
    });
    expect(req.temperature).toBe(1);
    expect(req.maxTokens).toBe(5000 + RESPONSE_HEADROOM_TOKENS);
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
  });

  it("each tier without override picks the tier-default budget (budget-style models)", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const { TIER_BUDGET_TOKENS } = await import("./model.js");
    const tiers: ReasoningTier[] = ["low", "medium", "high", "xhigh", "max"];
    for (const tier of tiers) {
      const req = buildAnthropicRequest({
        system: SYSTEM,
        messages: MESSAGES,
        tools: TOOLS,
        thinking: { tier },
      });
      const expectedBudget = TIER_BUDGET_TOKENS[tier];
      expect(req.thinking?.type, `tier ${tier}`).toBe("enabled");
      if (req.thinking?.type === "enabled") {
        expect(req.thinking.budget_tokens, `tier ${tier}`).toBe(expectedBudget);
      }
      expect(req.maxTokens, `tier ${tier}`).toBe(expectedBudget + RESPONSE_HEADROOM_TOKENS);
    }
  });
});

describe("buildAnthropicRequest — adaptive-style (Opus 4.7)", () => {
  const originalOverride = process.env.EVAL_MODEL_OVERRIDE;

  beforeEach(() => {
    process.env.EVAL_MODEL_OVERRIDE = "claude-opus-4-7";
    vi.resetModules();
  });
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = originalOverride;
  });

  it("thinking off: no temperature, no thinking payload, no outputConfig", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(req.model).toBe("claude-opus-4-7");
    expect(req.temperature).toBeUndefined();
    expect(req.maxTokens).toBe(RESPONSE_HEADROOM_TOKENS);
    expect(req.thinking).toBeUndefined();
    expect(req.outputConfig).toBeUndefined();
  });

  it("thinking on: adaptive payload with display:summarized + effort tier, no temperature", async () => {
    const { buildAnthropicRequest } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "medium", budgetTokensOverride: 8192 },
    });
    expect(req.temperature).toBeUndefined();
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.outputConfig).toEqual({ effort: "medium" });
  });

  it("each tier passes through to effort (low/medium/high/xhigh/max) — no clamping", async () => {
    const { buildAnthropicRequest } = await import("./anthropic.js");
    const tiers: ReasoningTier[] = ["low", "medium", "high", "xhigh", "max"];
    for (const tier of tiers) {
      const req = buildAnthropicRequest({
        system: SYSTEM,
        messages: MESSAGES,
        tools: TOOLS,
        thinking: { tier },
      });
      expect(req.outputConfig, `tier ${tier}`).toEqual({ effort: tier });
    }
  });
});

describe("buildAnthropicRequest — adaptive-style Claude-5-gen (Sonnet 5)", () => {
  const originalOverride = process.env.EVAL_MODEL_OVERRIDE;

  beforeEach(() => {
    process.env.EVAL_MODEL_OVERRIDE = "claude-sonnet-5";
    vi.resetModules();
  });
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = originalOverride;
  });

  // Sonnet 5 runs adaptive thinking by DEFAULT when `thinking` is omitted, so
  // "reasoning off" must send an explicit { type: "disabled" } — dropping the
  // field (correct for Opus 4.7/4.8) would silently run adaptive at default
  // effort here, skewing a reasoning-off run. Regression guard for the LEO-402
  // wiring (Codex review, PR #49).
  it("thinking off: emits explicit thinking:{type:'disabled'} (NOT omitted), no temperature/effort", async () => {
    const { buildAnthropicRequest, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(req.model).toBe("claude-sonnet-5");
    expect(req.temperature).toBeUndefined(); // sampling params dropped on Claude 5
    expect(req.thinking).toEqual({ type: "disabled" });
    expect(req.outputConfig).toBeUndefined();
    expect(req.maxTokens).toBe(RESPONSE_HEADROOM_TOKENS);
  });

  it("thinking on: adaptive payload with display:summarized + effort tier, no temperature", async () => {
    const { buildAnthropicRequest } = await import("./anthropic.js");
    const req = buildAnthropicRequest({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "medium", budgetTokensOverride: 8192 },
    });
    expect(req.temperature).toBeUndefined();
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.outputConfig).toEqual({ effort: "medium" });
  });
});

describe("effectiveTokenCap", () => {
  it("returns baseline when thinking is off", async () => {
    const { effectiveTokenCap } = await import("./anthropic.js");
    const { MAX_OUTPUT_TOKENS_PER_TRIAL } = await import("./model.js");
    expect(effectiveTokenCap({ level: "none" })).toBe(MAX_OUTPUT_TOKENS_PER_TRIAL);
  });

  it("scales with budget × iter ceiling when thinking is on", async () => {
    const { effectiveTokenCap, RESPONSE_HEADROOM_TOKENS } = await import("./anthropic.js");
    const { MAX_ITERATIONS_PER_TRIAL } = await import("./model.js");
    const cap = effectiveTokenCap({ level: "high", budgetTokens: 16384 });
    expect(cap).toBe((16384 + RESPONSE_HEADROOM_TOKENS) * MAX_ITERATIONS_PER_TRIAL);
  });

  it("never goes below the baseline cap even for tiny budgets", async () => {
    const { effectiveTokenCap } = await import("./anthropic.js");
    const { MAX_OUTPUT_TOKENS_PER_TRIAL } = await import("./model.js");
    // A 1024 budget × 30 iters × ~5K headroom = 153K, which is above
    // baseline 64K. Pick something synthetic that would compute under
    // baseline if Math.max weren't there.
    const cap = effectiveTokenCap({ level: "custom", budgetTokens: 1024 });
    expect(cap).toBeGreaterThanOrEqual(MAX_OUTPUT_TOKENS_PER_TRIAL);
  });
});

// Mock the Anthropic SDK module-scope so makeAnthropicAdapter().messages()
// can be exercised end-to-end without a network call. `createMock` is a
// vi.fn() each test sets up; the mocked SDK class delegates to it. Note
// the `vi.hoisted` indirection: vi.mock factory runs before module
// imports, so we have to declare the mock target via hoisted state.
const sdkMock = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: sdkMock.create };
  },
}));

describe("makeAnthropicAdapter — translation", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalOverride = process.env.EVAL_MODEL_OVERRIDE;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.EVAL_MODEL_OVERRIDE = "claude-opus-4-7";
    sdkMock.create.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalOverride === undefined) delete process.env.EVAL_MODEL_OVERRIDE;
    else process.env.EVAL_MODEL_OVERRIDE = originalOverride;
  });

  it("translates request thinking + populates vendor + model identity", async () => {
    sdkMock.create.mockResolvedValue({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    });
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const adapter = makeAnthropicAdapter();
    expect(adapter.vendor).toBe("anthropic");
    expect(adapter.model).toBe("claude-opus-4-7");
    await adapter.messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
      thinking: { tier: "medium" },
    });
    expect(sdkMock.create).toHaveBeenCalledTimes(1);
    const sdkParams = sdkMock.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sdkParams.model).toBe("claude-opus-4-7");
    expect(sdkParams.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sdkParams.output_config).toEqual({ effort: "medium" });
  });

  it("normalizes the SDK response into NormalizedMessage with vendor-keyed cacheTokens", async () => {
    const rawContent: Message["content"] = [
      { type: "text", text: "answer" } as unknown as Message["content"][number],
      {
        type: "tool_use",
        id: "tu_1",
        name: "launch_chrome",
        input: { headless: true },
      } as unknown as Message["content"][number],
    ];
    sdkMock.create.mockResolvedValue({
      id: "msg_42",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: rawContent,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    });
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const resp = await makeAnthropicAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp.id).toBe("msg_42");
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage.inputTokens).toBe(100);
    expect(resp.usage.outputTokens).toBe(50);
    expect(resp.usage.cacheTokens).toEqual({
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    });
    expect(resp.content).toHaveLength(2);
    expect(resp.content[0]).toEqual({ type: "text", text: "answer" });
    expect(resp.content[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "launch_chrome",
      input: { headless: true },
    });
  });

  it("preserves Anthropic thinking blocks under _rawAnthropicContent for transcript replay", async () => {
    const rawContent: Message["content"] = [
      {
        type: "thinking",
        thinking: "step 1",
        signature: "opaque-sig",
      } as unknown as Message["content"][number],
      { type: "text", text: "done" } as unknown as Message["content"][number],
    ];
    sdkMock.create.mockResolvedValue({
      id: "msg_99",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: rawContent,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const resp = await makeAnthropicAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      tools: TOOLS,
    });
    expect(resp._rawAnthropicContent).toBe(rawContent);
    // Normalized content tags thinking with vendor:"anthropic" and
    // preserves signature/thinking text verbatim.
    expect(resp.content[0]).toEqual({
      type: "thinking",
      vendor: "anthropic",
      thinking: "step 1",
      signature: "opaque-sig",
    });
  });

  it("maps unknown SDK stop_reason to 'other'", async () => {
    sdkMock.create.mockResolvedValue({
      id: "msg_x",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [],
      stop_reason: "pause_turn" as Message["stop_reason"],
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const resp = await makeAnthropicAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
    });
    expect(resp.stopReason).toBe("other");
  });
});

// #63: defense-in-depth retry wrap. The Anthropic SDK has its own
// internal retry; these tests prove the harness still recovers when
// the SDK's retries exhaust (or when the SDK surfaces an error class
// our classifier treats as retryable). Each test exercises a real
// ~1 s default backoff sleep (≈500–1500 ms jitter) — tolerated
// because the with-retry helper test already covers backoff math
// deterministically via injected clock; the adapter-level tests
// only need to prove the wrap is wired up correctly.
describe("makeAnthropicAdapter — retry/backoff (#63)", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.EVAL_MODEL_OVERRIDE = "claude-opus-4-7";
    sdkMock.create.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("retries once on TypeError('fetch failed') then succeeds, emits one onRetry", async () => {
    sdkMock.create
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({
        id: "msg_recovered",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    const onRetry = vi.fn();
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const resp = await makeAnthropicAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("msg_recovered");
    expect(sdkMock.create).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1 });
    expect(onRetry.mock.calls[0]![0].error).toMatch(/fetch failed/);
  }, 10_000);

  it("does NOT retry on 401-shaped SDK error", async () => {
    const err = Object.assign(new Error("authentication failed"), { status: 401 });
    sdkMock.create.mockRejectedValue(err);
    const onRetry = vi.fn();
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    await expect(
      makeAnthropicAdapter().messages({
        system: SYSTEM,
        messages: MESSAGES,
        onRetry,
      }),
    ).rejects.toBe(err);
    expect(sdkMock.create).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("classifies err.cause.code=ECONNRESET as retryable and recovers", async () => {
    // The pre-#65 ECONNRESET-exhaustion variant of this test was
    // timing-racy on slow CI (ARM runner saw 2 attempts when 1 was
    // expected from the short `timeoutMs: 50` deadline). The withRetry
    // helper test already covers exhaustion deterministically via the
    // injected clock; here we just need to prove the cause-code
    // classification path works at the adapter level.
    const err = Object.assign(new Error("socket hang up"), {
      cause: { code: "ECONNRESET" },
    });
    sdkMock.create.mockRejectedValueOnce(err).mockResolvedValueOnce({
      id: "msg_recovered",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const onRetry = vi.fn();
    const { makeAnthropicAdapter } = await import("./anthropic.js");
    const resp = await makeAnthropicAdapter().messages({
      system: SYSTEM,
      messages: MESSAGES,
      onRetry,
    });
    expect(resp.id).toBe("msg_recovered");
    expect(sdkMock.create).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0].error).toMatch(/ECONNRESET/);
  }, 10_000);
});
