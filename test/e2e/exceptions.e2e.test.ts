// L3 exceptions: verify set_pause_on_exceptions wires the
// Debugger.setPauseOnExceptions CDP method and triggers a pause when
// uncaught code throws. We inject the throw via Runtime.evaluate in a
// setTimeout so the pause is genuine uncaught-exception territory
// (synchronous evaluate would have the protocol return the exception
// via exceptionDetails rather than pausing the debugger).

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildToolMap,
  call,
  attachToTestChrome,
  sampleAppUrl,
} from "./helpers/build-tools.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

describe("exceptions (e2e)", () => {
  beforeEach(async () => setup());

  it("set_pause_on_exceptions: 'all' + async throw → pause", async () => {
    await call(tools, "set_pause_on_exceptions", { state: "all" });

    // Schedule an uncaught throw on the next tick so the debugger has a
    // chance to install the pause-on-exception handler before it fires.
    // Don't await evaluate — it doesn't pause.
    await call(tools, "evaluate", {
      expression: "setTimeout(() => { throw new Error('e2e-pause-on-exception') }, 50)",
    });

    const paused = await call<{ reason: string; call_stack: any[] }>(tools, "wait_for_pause", {
      timeout_ms: 10_000,
    });
    expect(paused.reason).toBe("exception");
    // CDP populates `data.description` with the thrown error description on
    // exception pauses. We don't assert exact text — older Chromium ships
    // a different format than Chrome stable.
    expect(paused.call_stack.length).toBeGreaterThan(0);

    await call(tools, "resume");
    // Restore to none so the spec doesn't rely on close_session's reset for
    // CDP-side cleanup. If close semantics ever change, this spec stays
    // self-contained (Opus PR #11 review nit 9).
    await call(tools, "set_pause_on_exceptions", { state: "none" });
  });
});
