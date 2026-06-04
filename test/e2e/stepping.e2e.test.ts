// L3 stepping: verify step_over / step_into / step_out advance the
// instruction pointer through TS-mapped frames. The actual line each step
// lands on is bundler-dependent (vite + esbuild may collapse some
// statements), so the spec asserts directional progress — "next pause is
// at a different location than the prior pause" — rather than hard-coded
// line numbers.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildToolMap,
  call,
  attachToTestChrome,
  sampleAppUrl,
} from "./helpers/build-tools.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
  await waitFor(
    async () => {
      // list_scripts returns a BARE ARRAY, not {items: [...]}.
      const r = await call<Array<{ original_sources?: string[] }>>(tools, "list_scripts");
      return r.some((s) => (s.original_sources ?? []).some((src) => src.endsWith("handlers.ts")));
    },
    { describe: "handlers.ts source-mapped" },
  );
}

describe("stepping (e2e)", () => {
  beforeEach(async () => setup());

  it("step_over advances to a new location in increment", async () => {
    // Break at the call site of computeStep (handlers.ts line 6 — the
    // 'const step = computeStep()' line). step_over should move past the
    // call to the next statement in increment.
    await call(tools, "set_breakpoint", { file: "handlers.ts", line: 6 });
    // Tail-end race on chrome stable: click's last dispatchMouseEvent
    // response can lose the WebSocket after the spec's resume completes.
    // The pause/step assertions above are what we care about; swallow
    // the tail rejection so it doesn't surface as an unhandled error.
    const clickPromise = call(tools, "click", { selector: "#go" }).catch(
      () => undefined,
    );

    const pause1 = await call<{ call_stack: Array<{ line: number; file: string }> }>(
      tools,
      "wait_for_pause",
      { timeout_ms: 10_000 },
    );
    const startLine = pause1.call_stack[0]!.line;
    expect(pause1.call_stack[0]!.file).toMatch(/handlers\.ts$/);

    const stepped = await call<{ paused: boolean; call_stack?: Array<{ line: number; file: string }> }>(
      tools,
      "step_over",
      { timeout_ms: 5_000 },
    );
    expect(stepped.paused).toBe(true);
    const nextLine = stepped.call_stack?.[0]?.line;
    expect(nextLine).toBeDefined();
    expect(nextLine).not.toBe(startLine); // moved somewhere

    await call(tools, "resume");
    await clickPromise;
  });

  it("step_into descends into computeStep", async () => {
    await call(tools, "set_breakpoint", { file: "handlers.ts", line: 6 });
    // Tail-end race on chrome stable: click's last dispatchMouseEvent
    // response can lose the WebSocket after the spec's resume completes.
    // The pause/step assertions above are what we care about; swallow
    // the tail rejection so it doesn't surface as an unhandled error.
    const clickPromise = call(tools, "click", { selector: "#go" }).catch(
      () => undefined,
    );

    await call(tools, "wait_for_pause", { timeout_ms: 10_000 });

    const stepped = await call<{
      paused: boolean;
      call_stack?: Array<{ function_name: string; line: number; file: string }>;
    }>(tools, "step_into", { timeout_ms: 5_000 });
    expect(stepped.paused).toBe(true);
    const top = stepped.call_stack?.[0];
    expect(top, `expected a top frame after step_into; got ${JSON.stringify(stepped)}`).toBeTruthy();
    // Top frame after step_into must be inside computeStep — assert on
    // file and line range instead of function_name (bundlers can
    // anonymize the function). computeStep's body is roughly lines 11–13
    // in handlers.ts (line 12 is `return 2;`). The function_name OR-chain
    // in the prior version was too loose to catch off-by-many regressions
    // (Opus PR #11 review M4).
    expect(top!.file).toMatch(/handlers\.ts$/);
    expect(top!.line).toBeGreaterThanOrEqual(11);
    expect(top!.line).toBeLessThanOrEqual(13);

    await call(tools, "resume");
    await clickPromise;
  });
});
