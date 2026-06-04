// L3 breakpoint flow: set a TS-source breakpoint, trigger via click, verify
// the pause lands on the right TS line, scope shows the right local var,
// and evaluate-on-frame computes the expected expression. This is the
// spec that validates source-map plumbing end-to-end against real
// Chromium.

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
  // The bundled scripts arrive after Page.loadEventFired (Vite emits
  // `<script type="module">` which is fetched async). Wait for handlers.ts
  // to be source-mapped before setting a breakpoint, otherwise no_mapping.
  await waitFor(
    async () => {
      // list_scripts returns a BARE ARRAY of script descriptors, not
      // {items: [...]}. (Distinct from get_console_logs / get_network_
      // requests which DO wrap in {cursor, items} for pagination.)
      const r = await call<Array<{ original_sources?: string[] }>>(tools, "list_scripts");
      return r.some((s) => (s.original_sources ?? []).some((src) => src.endsWith("handlers.ts")));
    },
    { describe: "handlers.ts source-mapped" },
  );
}

describe("breakpoint flow (e2e)", () => {
  beforeEach(async () => setup());

  it("set_breakpoint inside increment → click → pause at handlers.ts:7 → evaluate('count + step') === 2", async () => {
    // Set the breakpoint at handlers.ts:7 (`const next = count + step;`).
    // By that line, computeStep has already returned and `step` is bound
    // to its buggy value (2). count is 0 on the first click.
    //
    // Why not line 12 (the `return 2;` inside computeStep): pausing
    // there places frame 0 inside computeStep, where `step` does not
    // yet exist in the caller frame — `evaluate('count + step')` on
    // the caller would return NaN. Line 7 lets a single evaluate
    // exercise the source-map round-trip AND the buggy value chain in
    // one shot. (PR #11 CI exposed this — also why the sample-app's
    // build now uses minify:false: see examples/sample-app/vite.config.ts.)
    const bp = await call<{ id: string; resolved_locations: any[]; binding_count: number }>(
      tools,
      "set_breakpoint",
      { file: "handlers.ts", line: 7 },
    );
    expect(bp.resolved_locations.length).toBeGreaterThan(0);
    expect(bp.binding_count).toBeGreaterThan(0);

    // Click triggers the bug path. Don't await — wait_for_pause is what
    // the agent does next. Attach a no-op catch so a tail-end Input.
    // dispatchMouseEvent race (the WebSocket may close after resume on
    // chrome stable, before the last dispatch's response lands) doesn't
    // surface as an unhandled rejection. The pause/step/evaluate
    // assertions above are what this test validates; the click tool's
    // CDP cleanup is downstream cosmetics.
    const clickPromise = call(tools, "click", { selector: "#go" }).catch(
      () => undefined,
    );

    const pause = await call<{ reason: string; session_id: string | null; call_stack: any[] }>(
      tools,
      "wait_for_pause",
      { timeout_ms: 10_000 },
    );
    expect(pause.reason).toBe("other");
    // Frame 0 is increment. Chrome may resolve the breakpoint to a
    // nearby line (7 or 8 are equally plausible after the bundler's
    // line-by-line mapping); accept either.
    const top = pause.call_stack[0];
    expect(top.file).toMatch(/handlers\.ts$/);
    expect(top.line).toBeGreaterThanOrEqual(6);
    expect(top.line).toBeLessThanOrEqual(8);

    // Evaluate the buggy expression on frame 0. `count` resolves via the
    // closure (the outer `let count = 0` in main.ts is still 0 because
    // the assignment-back happens after increment returns); `step` is the
    // local set on line 6.
    const ev = await call<{ value?: number; preview?: string }>(tools, "evaluate", {
      expression: "count + step",
      frame_index: 0,
      return_by_value: true,
    });
    const numeric = ev.value ?? Number(ev.preview);
    expect(numeric).toBe(2);

    const resumed = await call<string>(tools, "resume");
    expect(resumed).toBe("resumed");

    // Click promise should now settle without throwing.
    await clickPromise;
  });

  it("set_breakpoint on a non-existent line returns no_mapping", async () => {
    // handlers.ts has only ~13 lines; line 999 has no mapping.
    const tool = tools.get("set_breakpoint")!;
    const env = await tool.handler({ file: "handlers.ts", line: 999 });
    expect(env.isError).toBe(true);
    const parsed = JSON.parse(env.content[0]!.text);
    expect(parsed.error).toBe("no_mapping");
  });
});
