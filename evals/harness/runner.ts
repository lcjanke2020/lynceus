// L4 trial runner — orchestrates one (scenario, trial) end-to-end:
//   1. Start a static server for the scenario's sample-app variant.
//   2. Spawn dist/index.js (the cdp-mcp server) as an MCP subprocess.
//   3. Run the Anthropic tool-use loop with the cdp-mcp tool list:
//        - send messages → assistant response → invoke tool_uses → repeat
//        - until end_turn / iteration cap / token cap.
//   4. Log every meaningful event to NDJSON via the trace writer.
//   5. Score the final answer + trace via the scenario's oracle.
//   6. Tear everything down.
//
// Budget: each trial consults the running cumulative cost from the
// outer aggregate (passed in via `BudgetTracker`); if the next trial
// would push past DEFAULT_BUDGET_USD (or EVAL_BUDGET_USD env override),
// runTrial throws with a clear message before doing API work. Trials
// already in flight are NOT interrupted — the cost is bounded by
// MAX_OUTPUT_TOKENS_PER_TRIAL.
//
// Cache control: the system prompt block AND the tool list's last entry
// are marked `cache_control: { type: "ephemeral" }` so the static prefix
// hits cache on every trial after the first. Measured size on cdp-mcp's
// current tool surface (45 tools, terse descriptions): the system block
// is ~280 tokens and the tools array is ~5K tokens. Anthropic's cache
// breakpoint minimum is ~1024 tokens, so the system-block marker is
// effectively a no-op for short scenario `systemPromptOverride` values
// (the adversarial-out-of-order MINIMAL_SYSTEM is ~70 tokens) — only the
// tools-array marker carries cross-trial reuse for those. Per-trial-
// varying data (the random-port variant URL) lives in the FIRST USER
// MESSAGE rather than the system prompt — putting it inside the cached
// span would change the cache key on every trial and defeat reuse (PR
// #15 review). Per-message tool_call / tool_result blocks are NOT cached
// either — they're per-trial by definition.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveTokenCap,
  makeAnthropicAdapter,
  type MessageParam,
  type TextBlock,
} from "./anthropic.js";
import type {
  NormalizedMessage,
  ThinkingRequest,
  VendorAdapter,
} from "./vendor.js";
import { spawnMcpServer, callMcpTool } from "./mcp-client.js";
import { openTraceWriter, type TraceWriter } from "./trace.js";
import { gradeTrial } from "./grader.js";
import {
  REASONING,
  MAX_ITERATIONS_PER_TRIAL,
  THINKING_STYLE,
  estimateCostUsd,
  tierToEffort,
} from "./model.js";
import { startStaticServer } from "./static-server.js";
import {
  resolveBrowser,
  isChromeLauncherDefault,
} from "../../src/util/browser-resolve.js";
import type {
  Scenario,
  ScenarioStartEntry,
  AssistantMsgEntry,
  AdapterRetryEntry,
  ToolCallEntry,
  ToolResultEntry,
  UsageEntry,
  ScenarioEndEntry,
  ThinkingEntry,
  ThinkingBlock,
  TraceEntry,
  TrialOutcome,
} from "./types.js";

export interface BudgetTracker {
  spentUsd: number;
  ceilingUsd: number;
}

export interface RunTrialOpts {
  scenario: Scenario;
  trial: number; // 1-based
  /** Where to drop the NDJSON trace. Resolved against `evals/runs/<runId>/`
   *  by the caller (cli.ts) so trial files cluster. */
  outDir: string;
  /** Shared budget — runTrial reads ceilingUsd and updates spentUsd. */
  budget: BudgetTracker;
  /** Variant root — the built dist/ directory of the scenario's
   *  sample-app fork (e.g., examples/sample-app/dist for the canonical). */
  variantDistDir: string;
  /** Optional override for the spawned MCP server path. */
  serverPath?: string;
  /** Test seam — inject a fake vendor adapter for unit tests. Defaults
   *  to a live Anthropic adapter using ANTHROPIC_API_KEY. The adapter's
   *  `vendor` + `model` are the single source of truth for
   *  `scenario_start.provider`, `scenario_start.model`, the trial
   *  filename (`<scenario>-<vendor>-<sanitized-model>-trial-<N>`), and
   *  the cost-billing identity. */
  adapter?: VendorAdapter;
}

const SYSTEM_PROMPT_PREFIX = `You are a Software Development Engineer in Test (SDET) doing manual exploratory testing of a Chrome DevTools Protocol (CDP) MCP server. The server exposes a TypeScript-aware frontend debugger to AI agents. Your job is to verify the debugger works correctly across each step of a standard debug session.

For each scenario you receive, you have TWO goals — both are scored:

  1. Test plan execution (PRIMARY). Exercise each step of the debugger workflow and verify each one performs as expected. The steps below are a semi-formal test plan; following them is the point of the work.

  2. Bug identification (SECONDARY). The scenario describes a bug. Find it. The bug exists as a concrete target the test plan converges on — but if you identify the bug without exercising the debugger workflow (e.g., by reading source alone), the debugger has NOT been tested.

Test plan, in order:
  1. launch_chrome (headless) or attach_chrome — verify the session opens cleanly.
  2. navigate to the URL — verify the page loads.
  3. list_scripts if useful — verify source maps are discovered.
  4. set_breakpoint on a TypeScript source line — verify source-map resolution works on the path you choose.
  5. click / type_text — verify the page driver fires events that reach your breakpoint.
  6. wait_for_pause — verify your breakpoint actually fires.
  7. get_call_stack / get_scope / evaluate — verify state inspection works at the pause point. Use evaluate to probe hypotheses about the bug at runtime.
  8. resume between investigations; close_session at the end — never leave the page paused.

get_script_source is available and sometimes necessary (to choose where to break), but it is NOT a substitute for the steps above. The point of this work is to test that the debugger tools function correctly — not to demonstrate that a sufficiently smart agent can shortcut around them.

When done, write a single short final answer naming the buggy file:line and the cause.

Common mistakes to avoid:
- Calling pause-only tools (get_call_stack, get_scope) without first establishing a pause.
- Forgetting to call wait_for_pause AFTER clicking something that triggers a breakpoint.
- Setting a breakpoint on a non-executable line (comments, blank lines, type declarations).`;

export async function runTrial(opts: RunTrialOpts): Promise<TrialOutcome> {
  const { scenario, trial, outDir, budget, variantDistDir } = opts;

  // Budget gate — bail BEFORE any API spend if we're already over.
  if (budget.spentUsd >= budget.ceilingUsd) {
    throw new BudgetExceeded(
      `Refusing to start ${scenario.name} trial ${trial}: spent $${budget.spentUsd.toFixed(2)} of $${budget.ceilingUsd.toFixed(2)} budget.`,
    );
  }

  // Resolve the vendor adapter up-front so the trace filename can embed
  // vendor + sanitized model id (issue #49). Defaults to a live Anthropic
  // adapter using ANTHROPIC_API_KEY.
  const adapter = opts.adapter ?? makeAnthropicAdapter();

  mkdirSync(outDir, { recursive: true });
  const filenameBase = `${scenario.name}-${adapter.vendor}-${sanitizeModelId(adapter.model)}-trial-${trial}`;
  const tracePath = join(outDir, `${filenameBase}.ndjson`);
  const thinkingPath = join(outDir, `${filenameBase}.thinking.ndjson`);
  const writer = openTraceWriter(tracePath);
  const trace: TraceEntry[] = []; // in-memory mirror for grading at the end

  // Sidecar NDJSON for thinking blocks — lazily opened the first time an
  // iter actually produces thinking. No-thinking runs never create this
  // file; medium/high-thinking runs accumulate one entry per iter that
  // emitted thinking. Joined to the main trace on the `iter` field.
  let thinkingWriter: TraceWriter<ThinkingEntry> | null = null;
  function emitThinking(entry: ThinkingEntry): void {
    if (!thinkingWriter) {
      thinkingWriter = openTraceWriter<ThinkingEntry>(thinkingPath);
    }
    thinkingWriter.write(entry);
  }

  const startMs = Date.now();
  const server = await startStaticServer(variantDistDir);
  const variantUrl = server.url;

  // Resolve the Chrome/Chromium binary the spawned MCP server should drive.
  // Shared with L3 (test/e2e/setup/global.ts) — both layers go through one
  // resolution path so they can't test against different protocol revisions
  // (docs/test-eval-plan.md §L3, plan rev 3 Cursor open-Q-2 resolution).
  // The path is plumbed to the subprocess via CHROME_PATH; chrome-launcher
  // honors it natively, so production launchChrome (src/session/browser.ts)
  // doesn't need to read CDP_TEST_BROWSER_PATH itself. If the resolver
  // returns the chrome-launcher-default marker (only when CDP_TEST_BROWSER=
  // chrome and no override is set), omit CHROME_PATH so chrome-launcher
  // runs its own detection — same policy as L3.
  const browser = resolveBrowser();
  const extraEnv: Record<string, string> = isChromeLauncherDefault(browser)
    ? {}
    : { CHROME_PATH: browser.binaryPath };
  // Opt-in: run the model-launched Chromium WITH the sandbox. Default OFF —
  // the automation default is --no-sandbox (docs/chromium-sandboxing.md). The
  // model controls launch_chrome's `sandbox` arg and normally omits it, so to
  // run a whole suite sandbox-on without prompt-injecting every scenario we
  // plumb CDP_SANDBOX=true to the server, which uses it as the launch default.
  // Use only on a host with a working sandbox path (AppArmor userns allowance
  // or SUID chrome_sandbox helper).
  if (process.env.EVAL_SANDBOX === "true" || process.env.EVAL_SANDBOX === "1") {
    extraEnv.CDP_SANDBOX = "true";
    process.stderr.write(
      `[eval] EVAL_SANDBOX set — launching Chromium with the sandbox on (CDP_SANDBOX=true)\n`,
    );
  }
  process.stderr.write(
    `[eval] resolved browser: ${browser.binaryPath} (source=${browser.source})\n`,
  );
  const mcp = await spawnMcpServer({
    ...(opts.serverPath ? { serverPath: opts.serverPath } : {}),
    env: extraEnv,
  });

  // System prompt = the static prefix (or scenario's override). Marked
  // cache_control so the full system + tools span hits cache on every
  // trial after the first. The per-trial variant URL goes into the
  // first user message below, NOT into the system block — see header
  // note for the cache-key rationale.
  const systemPrefix = scenario.systemPromptOverride ?? SYSTEM_PROMPT_PREFIX;
  const system: TextBlock[] = [
    {
      type: "text",
      text: systemPrefix,
      cache_control: { type: "ephemeral" },
    } as TextBlock & { cache_control: { type: "ephemeral" } },
  ];

  // For adaptive runs, record the resolved effort tier alongside the
  // harness's `reasoning.level` — otherwise xhigh/max trace rows look
  // identical to high since the level field doesn't reflect any clamp.
  const resolvedEffort =
    THINKING_STYLE === "adaptive" &&
    REASONING.level !== "none" &&
    REASONING.budgetTokens !== undefined
      ? tierToEffort(REASONING.level)
      : undefined;

  const startEntry: ScenarioStartEntry = {
    t: "scenario_start",
    ts: new Date().toISOString(),
    scenario: scenario.name,
    trial,
    provider: adapter.vendor,
    model: adapter.model,
    reasoning: REASONING,
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    variantUrl,
  };
  writer.write(startEntry);
  trace.push(startEntry);

  // First user message carries only the per-trial URL + the scenario's
  // natural-language prompt. The scenario.name is intentionally NOT
  // surfaced to the model — names like "network-bug", "console-error",
  // "worker-bug" are diagnostic labels that telegraph the answer (Codex
  // re-review on PR #15). Correlation between transcript and trace is
  // already preserved via the scenario_start NDJSON entry.
  const messages: MessageParam[] = [
    {
      role: "user",
      content: `Page under test: ${variantUrl}\n\n${scenario.prompt}`,
    },
  ];

  let finalAnswer = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  /** Sum of vendor-tagged cache token activity across iterations. Keyed
   *  by vendor-native field name (Anthropic uses `cacheCreationInputTokens`
   *  + `cacheReadInputTokens`; other vendors use their own keys). */
  const totalCacheTokens: Record<string, number> = {};
  /** Cumulative USD cost, accumulated per-iteration. PR #60 re-review
   *  (gpt-5 #2): OpenAI bills per request — a session that crossed the
   *  long-context threshold in some iterations but not others would
   *  get the wrong rate under a totals-based check. Per-iter
   *  accumulation matches OpenAI's billing semantics exactly and is
   *  cost-neutral for vendors whose rates don't depend on per-request
   *  token counts (Anthropic, LM Studio sentinel). */
  let totalCostUsd = 0;
  let toolCallCount = 0;
  let iter = 0;

  // Computed once per trial — `effectiveTokenCap` depends only on
  // module-load-time constants (REASONING + MAX_*), not on per-iter state.
  const tokenCap = effectiveTokenCap(REASONING);

  try {
    for (iter = 1; iter <= MAX_ITERATIONS_PER_TRIAL; iter++) {
      // Budget pre-check between iterations — if completed iters have
      // already pushed us past the ceiling, stop without making the
      // next API call. `totalCostUsd` is the per-iter accumulator
      // (PR #60 re-review #2), so this check reflects what we've
      // actually been billed per-request, not a totals-based
      // approximation.
      if (budget.spentUsd + totalCostUsd >= budget.ceilingUsd) {
        finalAnswer +=
          `\n[budget halt: spent + provisional ($${(budget.spentUsd + totalCostUsd).toFixed(2)}) >= ceiling ($${budget.ceilingUsd.toFixed(2)}); aborting at iter ${iter}]`;
        break;
      }

      if (totalOutputTokens >= tokenCap) {
        finalAnswer += `\n[token halt: produced ${totalOutputTokens} output tokens; cap is ${tokenCap}]`;
        break;
      }

      const thinkingReq: ThinkingRequest | undefined =
        REASONING.level === "none" || REASONING.budgetTokens === undefined
          ? undefined
          : {
              tier: tierToEffort(REASONING.level),
              budgetTokensOverride: REASONING.budgetTokens,
            };

      const resp: NormalizedMessage = await adapter.messages({
        system,
        messages,
        tools: mcp.anthropicTools,
        ...(thinkingReq ? { thinking: thinkingReq } : {}),
        // #63: each retried attempt emits one trace line — joined to
        // the eventual `assistant_msg` below via the shared `iter`
        // field. Not emitted on the final successful attempt.
        onRetry: (ev) => {
          const entry: AdapterRetryEntry = {
            t: "adapter_retry",
            ts: new Date().toISOString(),
            iter,
            attempt: ev.attempt,
            error: ev.error,
            backoffMs: ev.backoffMs,
          };
          writer.write(entry);
          trace.push(entry);
        },
      });

      // Walk the normalized content into the split shape the trace
      // writer expects. Equivalent to the old splitAssistantContent
      // helper, but kept inline because the runner is its only consumer
      // post-#47.
      let text = "";
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const thinkingBlocks: ThinkingBlock[] = [];
      for (const block of resp.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        } else if (block.type === "thinking") {
          // ThinkingBlock (sidecar shape) carries `signature` because
          // Anthropic adaptive-mode round-trip requires it. OpenAI's
          // round-trip mechanism (#58) is `encryptedContent` + `itemId`
          // — totally different — and the sidecar shape doesn't model
          // those (the round-trip happens via the adapter re-emitting
          // the normalized thinking block on the next iter's input
          // translation, NOT via the sidecar). So OpenAI's sidecar
          // entry gets the summary text + an empty signature; the
          // adapter holds the round-trip state in the normalized
          // content blocks the runner pushes onto `messages`.
          thinkingBlocks.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.vendor === "anthropic" ? block.signature : "",
          });
        } else if (block.type === "redacted_thinking") {
          thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
        } else {
          // Exhaustiveness check (#58, bundled per design decision).
          // If the NormalizedMessage content union ever gains a new
          // variant (e.g. a Vertex thinking variant in #51), this
          // assignment becomes a compile error so the new variant
          // gets considered for sidecar emission. Don't silently
          // drop unknown blocks.
          const _exhaustive: never = block;
          void _exhaustive;
        }
      }

      const cacheTokens = resp.usage.cacheTokens ?? {};
      totalInputTokens += resp.usage.inputTokens;
      totalOutputTokens += resp.usage.outputTokens;
      for (const [k, v] of Object.entries(cacheTokens)) {
        totalCacheTokens[k] = (totalCacheTokens[k] ?? 0) + v;
      }
      // Per-iter cost accumulation (PR #60 re-review #2). Bills this
      // iteration against its OWN prompt_tokens — so OpenAI's
      // long-context tier swap kicks in only for iterations whose
      // individual prompt crossed 272K, matching the API's actual
      // per-request billing semantics. For vendors with flat rates
      // (Anthropic, LM Studio sentinel) this gives an identical
      // result to the pre-fix totals-based sum.
      totalCostUsd += estimateCostUsd(adapter.vendor, adapter.model, {
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        cacheTokens,
      });

      // Thinking blocks (when extended thinking is enabled) go to the
      // sidecar — joined to the iter's assistant_msg below via the
      // shared `iter` field.
      if (thinkingBlocks.length > 0) {
        emitThinking({
          t: "thinking",
          ts: new Date().toISOString(),
          iter,
          blocks: thinkingBlocks,
        });
      }

      const assistantEntry: AssistantMsgEntry = {
        t: "assistant_msg",
        ts: new Date().toISOString(),
        iter,
        text,
        toolUses,
        stopReason: resp.stopReason,
      };
      writer.write(assistantEntry);
      trace.push(assistantEntry);

      const usageEntry: UsageEntry = {
        t: "usage",
        ts: new Date().toISOString(),
        iter,
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
        ...(Object.keys(cacheTokens).length > 0 ? { cacheTokens } : {}),
      };
      writer.write(usageEntry);
      trace.push(usageEntry);

      // Append the assistant message to the running transcript.
      //
      // Branch on adapter.vendor (#51 — PR-#54-review follow-up): the
      // `_rawAnthropicContent` escape hatch only makes sense for the
      // Anthropic adapter, which populates it with the SDK's native
      // content blocks (including thinking-block `signature` fields
      // required for adaptive round-trip). Non-Anthropic adapters leave
      // it undefined and translate `resp.content` (the normalized
      // vendor-agnostic shape, possibly carrying their own vendor-tagged
      // thinking blocks — Vertex's `thoughtSignature`, OpenAI's
      // `itemId`+`encryptedContent`) back to their wire format on the
      // next `messages()` call.
      //
      // The pre-#51 single-line cast (`(resp._rawAnthropicContent ??
      // resp.content) as MessageParam["content"]`) would have happily
      // fed a Vertex thinking block into a hypothetical Anthropic
      // request if some future code path ever mixed vendors mid-trial.
      // The explicit branch removes that silent leak path — the
      // Anthropic-shape cast is gated on `adapter.vendor === "anthropic"`.
      if (adapter.vendor === "anthropic") {
        messages.push({
          role: "assistant",
          content: (resp._rawAnthropicContent ?? resp.content) as MessageParam["content"],
        });
      } else {
        messages.push({
          role: "assistant",
          content: resp.content as MessageParam["content"],
        });
      }

      if (resp.stopReason === "end_turn" || toolUses.length === 0) {
        finalAnswer += text;
        break;
      }

      // Invoke each tool_use and gather tool_result blocks.
      const toolResultBlocks: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];

      for (const tu of toolUses) {
        toolCallCount += 1;
        const callEntry: ToolCallEntry = {
          t: "tool_call",
          ts: new Date().toISOString(),
          iter,
          toolUseId: tu.id,
          tool: tu.name,
          input: tu.input,
        };
        writer.write(callEntry);
        trace.push(callEntry);

        let toolOut: { isError: boolean; content: unknown };
        let errorCode: string | undefined;
        try {
          toolOut = await callMcpTool(mcp.client, tu.name, tu.input);
          if (
            toolOut.isError &&
            toolOut.content &&
            typeof toolOut.content === "object" &&
            "error" in (toolOut.content as Record<string, unknown>)
          ) {
            errorCode = String((toolOut.content as { error: unknown }).error);
          }
        } catch (e) {
          toolOut = {
            isError: true,
            content: { error: "transport_error", message: String(e) },
          };
          errorCode = "transport_error";
        }

        const resultEntry: ToolResultEntry = {
          t: "tool_result",
          ts: new Date().toISOString(),
          iter,
          toolUseId: tu.id,
          tool: tu.name,
          isError: toolOut.isError,
          ...(errorCode ? { errorCode } : {}),
          output: toolOut.content,
        };
        writer.write(resultEntry);
        trace.push(resultEntry);

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(toolOut.content),
          ...(toolOut.isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: "user", content: toolResultBlocks });
    }
  } finally {
    // Always clean up, even if the loop threw or aborted.
    try {
      await mcp.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    // Adapter-level scenario-scoped cleanup (#51). The Vertex adapter
    // implements this to delete the trial's `cachedContents` resource.
    // Best-effort — a stuck remote-side cleanup shouldn't fail an
    // otherwise-green trial, so we catch + warn rather than re-throw.
    if (adapter.endScenario) {
      try {
        await adapter.endScenario();
      } catch (e) {
        process.stderr.write(
          `[runner] WARN: adapter.endScenario() rejected on ${scenario.name} trial ${trial}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }

  // Final scoring. Cost is the per-iter accumulator (PR #60 re-review
  // #2) — under OpenAI's long-context tier, this correctly bills only
  // iterations whose individual prompt_tokens crossed 272K at the
  // long-context rate, rather than swap rates on cumulative totals
  // that no single request matched.
  const oracle = gradeTrial(scenario, trace, finalAnswer);
  const costUsd = totalCostUsd;
  budget.spentUsd += costUsd;

  const elapsedMs = Date.now() - startMs;
  const endEntry: ScenarioEndEntry = {
    t: "scenario_end",
    ts: new Date().toISOString(),
    scenario: scenario.name,
    trial,
    finalAnswer,
    oracle,
    elapsedMs,
    totals: {
      iters: iter,
      toolCalls: toolCallCount,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheTokens: totalCacheTokens,
      costUsd,
    },
  };
  writer.write(endEntry);
  await writer.close();
  // The cast looks redundant given the `if` check, but TS's control-flow
  // analysis only sees the initial `let thinkingWriter = null` declaration
  // here — it can't observe that `emitThinking()` (a closure) may have
  // reassigned the variable to a TraceWriter, so it narrows to `never`
  // inside the if-branch. The cast restores the actual runtime type.
  if (thinkingWriter) await (thinkingWriter as TraceWriter<ThinkingEntry>).close();

  return {
    scenario: scenario.name,
    trial,
    oracle,
    elapsedMs,
    costUsd,
    tracePath,
  };
}

export class BudgetExceeded extends Error {
  override readonly name = "BudgetExceeded";
}

/** Sanitize a model id for use in a file path — e.g.
 *  `nvidia/nemotron-3-super` → `nvidia_nemotron-3-super`.
 *  @internal exposed for unit tests in evals/harness/trace.test.ts. */
export function sanitizeModelId(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]/g, "_");
}
