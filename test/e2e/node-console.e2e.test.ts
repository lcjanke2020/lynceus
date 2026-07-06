// L3 Node console: V8's Runtime.consoleAPICalled event is routed into the
// same get_console_logs buffer the browser side uses. Confirms the kind-
// agnostic console path on Node sessions. (Browser parity is exercised
// by console.e2e.test.ts.)
//
// We reuse the existing examples/sample-node-app/dist/index.js fixture —
// it runs `console.log(greet("world"))` (src/index.ts:3) which produces
// the search target. No new fixture entry needed.

import { describe, it, expect } from "vitest";
import { buildToolMap, call } from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

describe("node console (e2e)", () => {
  it("console.log from a Node session surfaces via get_console_logs", async () => {
    await call(tools, "launch_node", { script: fixtureScript("index") });

    // Drain --inspect-brk entry pause; console output only fires post-resume.
    await call(tools, "wait_for_pause", { timeout_ms: 10_000 });
    await call(tools, "resume");

    const logs = await waitFor(
      async () => {
        const r = await call<{
          items: Array<{ text: string; level: string; file?: string }>;
        }>(tools, "get_console_logs", { search: "hello" });
        return r.items.length > 0 ? r.items : null;
      },
      { describe: "console.log 'hello, world' appears" },
    );

    const entry = logs[0]!;
    expect(entry.text).toMatch(/hello, world/);
    expect(entry.level).toBe("log");
    // Soft assertion on the source-mapped file (mirrors console.e2e.test.ts:43).
    // The greet() call site is in index.ts; the msg construction is in
    // handlers.ts. Either is acceptable when console mapping is populated.
    if (entry.file) {
      expect(entry.file).toMatch(/(handlers|index)\.ts$/);
    }
  });
});
