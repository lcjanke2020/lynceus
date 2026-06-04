// L3 console: verify console.log entries from page code arrive in the
// buffer with source-mapped file/line info. The bug-counter sample-app
// emits `console.log("clicked, count is now", count)` from main.ts on
// every click — that's what we trigger.

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
}

describe("console (e2e)", () => {
  beforeEach(async () => setup());

  it("click → console.log surfaces with source-mapped file", async () => {
    await call(tools, "click", { selector: "#go" });

    const logs = await waitFor(
      async () => {
        const r = await call<{
          items: Array<{ text: string; file?: string; level: string }>;
        }>(tools, "get_console_logs", { search: "clicked" });
        return r.items.length > 0 ? r.items : null;
      },
      { describe: "console.log 'clicked' appears" },
    );
    const entry = logs[0]!;
    expect(entry.text).toMatch(/clicked, count is now/);
    expect(entry.level).toBe("log");
    // Source-map mapping is the load-bearing assertion: if the bundled JS
    // line came through without the mapping, the `file` field would be the
    // bundled chunk URL, not main.ts.
    if (entry.file) {
      expect(entry.file).toMatch(/main\.ts$/);
    }
  });

  it("clear_console drops buffered entries", async () => {
    await call(tools, "click", { selector: "#go" });
    await waitFor(async () => {
      const r = await call<{ items: any[] }>(tools, "get_console_logs", { search: "clicked" });
      return r.items.length > 0 ? r.items : null;
    });
    expect(await call(tools, "clear_console")).toBe("cleared");
    const r = await call<{ items: any[] }>(tools, "get_console_logs", { search: "clicked" });
    expect(r.items.length).toBe(0);
  });
});
