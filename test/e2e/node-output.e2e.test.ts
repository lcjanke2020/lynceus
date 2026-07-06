// L3 Node output: launch_node owns the child stdio, so
// process.stdout.write lines from the debuggee surface via
// get_node_output. They do NOT appear in get_console_logs — that buffer
// captures only V8's Runtime.consoleAPICalled stream (channel separation
// per src/tools/node-output.ts header).
//
// stdio-bug.ts deliberately prints via process.stdout.write (not
// console.log) so this test can exercise the channel-separation contract
// directly. If the fixture ever switched to console.log, the negative-
// assertion below would fail and the L4 node-stdio-bug signal
// would be diluted.

import { describe, it, expect } from "vitest";
import { buildToolMap, call } from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

describe("node output (e2e)", () => {
  it("launch_node child stdio → get_node_output captures it; get_console_logs does NOT", async () => {
    await call(tools, "launch_node", { script: fixtureScript("stdio-bug") });

    await call(tools, "wait_for_pause", { timeout_ms: 10_000 });
    await call(tools, "resume");

    // Poll until the buggy total surfaces. With off-by-one accumulator
    // on [1,2,3,4,5]: 1+1 + 2+1 + 3+1 + 4+1 + 5+1 = 20.
    const out = await waitFor(
      async () => {
        const r = await call<{
          cursor: number;
          items: Array<{ seq: number; ts: number; stream: string; text: string }>;
        }>(tools, "get_node_output", { search: "total" });
        return r.items.length > 0 ? r : null;
      },
      { describe: "get_node_output 'total: 20' appears" },
    );

    const totalLine = out.items.find((i) => /total: 20/.test(i.text));
    expect(
      totalLine,
      `expected 'total: 20'; got [${out.items.map((i) => i.text.trim()).join(" | ")}]`,
    ).toBeTruthy();
    expect(totalLine!.stream).toBe("stdout");

    // Pagination: passing the returned cursor as `since` yields no new items.
    const after = await call<{
      cursor: number;
      items: Array<{ seq: number; text: string }>;
    }>(tools, "get_node_output", { search: "total", since: out.cursor });
    expect(after.items).toHaveLength(0);

    // Channel separation. Raw process.stdout.write does NOT route through
    // V8's Runtime.consoleAPICalled, so the same line MUST NOT appear in
    // get_console_logs. Run this AFTER the positive poll so the script has
    // had time to print — otherwise an empty result could be a race.
    const consoleLogs = await call<{
      items: Array<{ text: string }>;
    }>(tools, "get_console_logs", { search: "total" });
    expect(consoleLogs.items).toHaveLength(0);

    // close_session against the launched child exercises the SIGTERM→SIGKILL
    // escalation path on the owned process.
    expect(await call<string>(tools, "close_session")).toBe("closed");
  });
});
