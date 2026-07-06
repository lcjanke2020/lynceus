// L3 Node exceptions: launch_node against throw.ts, install
// set_pause_on_exceptions WHILE STILL paused at the --inspect-brk entry
// (before the first resume), then resume — the TypeError in processItem
// pauses execution so the agent can inspect the scope. Skipping the
// entry-pause install would race the throw and exit the process before
// re-pausing; there's no browser analogue.
//
// Why state: "all" instead of "uncaught":
//   Node wraps the ESM module's top-level evaluation in its own internal
//   try/catch (so the runtime can emit a process-level error event before
//   exiting non-zero). V8 sees that upstream catch and classifies a
//   synchronous module-level throw as CAUGHT, so state="uncaught" does
//   NOT pause for our throw.ts. state="all" pauses on every exception
//   regardless of upstream handlers and exercises the same CDP plumbing.
//   The same nuance is why exceptions.e2e.test.ts (browser side) uses
//   state="all" with a setTimeout-thrown error.
//
// Reason field is intentionally NOT asserted — V8 on Node emits non-
// standard strings (see node-breakpoint-flow.e2e.test.ts file header).
// Load-bearing assertions are the call_stack shape, the throwing frame's
// file, and the scope contents.

import { describe, it, expect } from "vitest";
import { buildToolMap, call } from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";

const tools = buildToolMap();

describe("node exceptions (e2e)", () => {
  it("set_pause_on_exceptions at entry → resume → uncaught throw pauses in processItem", async () => {
    await call(tools, "launch_node", { script: fixtureScript("throw") });

    // Entry pause — install pause-on-exceptions BEFORE the first resume.
    const entry = await call<{
      hit_breakpoint_ids: string[];
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(entry.hit_breakpoint_ids).toEqual([]);

    const sope = await call<{
      state: string;
      sessions_applied: number;
      failures: unknown[];
    }>(tools, "set_pause_on_exceptions", { state: "all" });
    expect(sope.state).toBe("all");
    expect(sope.sessions_applied).toBeGreaterThanOrEqual(1);
    expect(sope.failures).toEqual([]);

    await call(tools, "resume");

    const paused = await call<{
      reason: string;
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number; function_name?: string }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(paused.hit_breakpoint_ids).toEqual([]);
    expect(paused.call_stack.length).toBeGreaterThanOrEqual(2);
    expect(paused.call_stack[0]!.file).toMatch(/throw\.ts$/);

    // get_call_stack — separate tool, same shape contract. Verifying the
    // tool works against the exception-pause state.
    const stack = await call<Array<{ file: string; line: number; function_name?: string }>>(
      tools,
      "get_call_stack",
    );
    expect(stack.length).toBeGreaterThanOrEqual(2);
    expect(stack[0]!.file).toMatch(/throw\.ts$/);

    // get_scope local — `item` should be bound to null on the throwing
    // iteration. The exact value-vs-preview shape varies across V8 builds,
    // so accept any of (a) value === null, (b) preview contains "null",
    // (c) type === "null".
    const scope = await call<{
      items: Array<{ name: string; type?: string; preview?: string; value?: unknown }>;
    }>(tools, "get_scope", { scope_type: "local" });
    const itemEntry = scope.items.find((i) => i.name === "item");
    expect(
      itemEntry,
      `expected 'item' in local scope; got [${scope.items.map((i) => i.name).join(", ")}]`,
    ).toBeTruthy();
    const seemsNull =
      itemEntry!.value === null ||
      (typeof itemEntry!.preview === "string" && itemEntry!.preview.toLowerCase().includes("null")) ||
      itemEntry!.type === "null";
    expect(
      seemsNull,
      `expected 'item' to look null; got value=${JSON.stringify(itemEntry!.value)} preview=${itemEntry!.preview} type=${itemEntry!.type}`,
    ).toBe(true);

    // Self-contained cleanup — don't rely on close_session's reset.
    await call(tools, "set_pause_on_exceptions", { state: "none" });
    await call(tools, "resume");
  });
});
