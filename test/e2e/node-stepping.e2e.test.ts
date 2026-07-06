// L3 Node stepping: launch_node against compute-step.ts, set a bp on the
// tick() call site, then step_into computeStep / step_over within it /
// step_out back to tick. Assertions mix fixture-specific line numbers (the
// bp line and computeStep's body range) with structural checks — directional
// line movement plus frame-depth grow/steady/shrink across step_into /
// step_over / step_out — in the spirit of the browser-side stepping.e2e.test.ts.

import { describe, it, expect } from "vitest";
import { buildToolMap, call } from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";

const tools = buildToolMap();

describe("node stepping (e2e)", () => {
  it("launch_node → bp on tick() → step_into → step_over → step_out", async () => {
    await call(tools, "launch_node", { script: fixtureScript("compute-step") });

    // --inspect-brk entry pause — no user breakpoints yet.
    const entry = await call<{
      hit_breakpoint_ids: string[];
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(entry.hit_breakpoint_ids).toEqual([]);

    // Breakpoint on tick()'s call to computeStep (compute-step.ts line 12).
    const bp = await call<{
      id: string;
      status: string;
      binding_count: number;
    }>(tools, "set_breakpoint", { file: "compute-step.ts", line: 12 });
    expect(bp.status).toBe("set");
    expect(bp.binding_count).toBeGreaterThanOrEqual(1);

    await call(tools, "resume");

    // Pause at bp — top frame is tick() at line 12. Frame depth: tick + main.
    const atBp = await call<{
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number; function_name?: string }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(atBp.hit_breakpoint_ids).toContain(bp.id);
    expect(atBp.call_stack[0]!.file).toMatch(/compute-step\.ts$/);
    expect(atBp.call_stack[0]!.line).toBe(12);
    const depthAtBp = atBp.call_stack.length;
    expect(depthAtBp).toBeGreaterThanOrEqual(2);

    // step_into descends into computeStep — top frame moves into the
    // computeStep body (lines 6-9), depth grows.
    const intoStep = await call<{
      paused: boolean;
      call_stack?: Array<{ file: string; line: number; function_name?: string }>;
    }>(tools, "step_into", { timeout_ms: 5_000 });
    expect(intoStep.paused).toBe(true);
    expect(intoStep.call_stack?.[0]?.file).toMatch(/compute-step\.ts$/);
    const intoLine = intoStep.call_stack![0]!.line;
    expect(intoLine).toBeGreaterThanOrEqual(6);
    expect(intoLine).toBeLessThanOrEqual(9);
    expect(intoStep.call_stack!.length).toBeGreaterThan(depthAtBp);

    // step_over within computeStep — line advances but stays inside the
    // function. Assert directional progress (line moved) AND that the
    // top frame stayed inside computeStep's body (lines 6-9) AND that
    // stack depth is unchanged from the post-step_into depth. A regression
    // where step_over behaved like step_out (depth shrinks, frame leaves
    // computeStep) would pass a line-only check; only step_out should
    // shrink depth.
    const stepOver = await call<{
      paused: boolean;
      call_stack?: Array<{ file: string; line: number }>;
    }>(tools, "step_over", { timeout_ms: 5_000 });
    expect(stepOver.paused).toBe(true);
    expect(stepOver.call_stack![0]!.file).toMatch(/compute-step\.ts$/);
    expect(stepOver.call_stack![0]!.line).not.toBe(intoLine);
    expect(stepOver.call_stack![0]!.line).toBeGreaterThanOrEqual(6);
    expect(stepOver.call_stack![0]!.line).toBeLessThanOrEqual(9);
    expect(stepOver.call_stack!.length).toBe(intoStep.call_stack!.length);

    // step_out back to tick() — depth shrinks below the step_into depth.
    const stepOut = await call<{
      paused: boolean;
      call_stack?: Array<{ file: string; line: number }>;
    }>(tools, "step_out", { timeout_ms: 5_000 });
    expect(stepOut.paused).toBe(true);
    expect(stepOut.call_stack![0]!.file).toMatch(/compute-step\.ts$/);
    expect(stepOut.call_stack!.length).toBeLessThan(intoStep.call_stack!.length);

    await call(tools, "resume");
  });
});
