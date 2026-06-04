import { describe, it, expect } from "vitest";
import { sessionState } from "../../src/session/state.js";
import { registerConsoleTools } from "../../src/tools/console.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerConsoleTools);
const getLogs = tools.get("get_console_logs")!;
const clearLogs = tools.get("clear_console")!;

const seedConsoleEntry = (
  level: "log" | "info" | "warn" | "error" | "debug" | "trace" | "verbose",
  text: string,
  extra: Partial<{ mappedFile: string; mappedLine: number; url: string; lineNumber: number }> = {},
) => {
  sessionState.console.push({
    ts: Date.now(),
    level,
    text,
    source: "console-api",
    ...extra,
  });
};

describe("get_console_logs", () => {
  it("no_session: returns the structured error envelope when no session is active", async () => {
    setupSession({ noClient: true });
    const r = await getLogs.handler({});
    expect(parseErrorEnvelope(r)).toEqual({
      error: "no_session",
      message: expect.stringContaining("Call launch_chrome"),
    });
  });

  it("returns buffered entries with cursor equal to the last item's seq", async () => {
    setupSession();
    seedConsoleEntry("log", "first");
    seedConsoleEntry("warn", "second");
    seedConsoleEntry("error", "third");
    const r = parseOkEnvelope<{ cursor: number; items: any[] }>(await getLogs.handler({}));
    expect(r.items.map((i) => i.text)).toEqual(["first", "second", "third"]);
    expect(r.items.map((i) => i.level)).toEqual(["log", "warn", "error"]);
    // Cursor is the last item's seq (assert relation, not absolute, because
    // RingBuffer.nextSeq persists across test resets — clear() only empties
    // items, by design).
    expect(r.cursor).toBe(r.items[r.items.length - 1].seq);
  });

  it("`since` paginates from a previous cursor", async () => {
    setupSession();
    for (let i = 0; i < 5; i++) seedConsoleEntry("log", `m${i}`);
    const first = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getLogs.handler({ limit: 2 }),
    );
    expect(first.items.map((i) => i.text)).toEqual(["m3", "m4"]);
    expect(first.cursor).toBe(first.items[first.items.length - 1].seq);
    seedConsoleEntry("log", "m5");
    const next = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getLogs.handler({ since: first.cursor }),
    );
    expect(next.items.map((i) => i.text)).toEqual(["m5"]);
  });

  it("`level` filter narrows by entry level", async () => {
    setupSession();
    seedConsoleEntry("log", "lo");
    seedConsoleEntry("warn", "wa");
    seedConsoleEntry("error", "er");
    const r = parseOkEnvelope<{ items: any[] }>(await getLogs.handler({ level: "error" }));
    expect(r.items.map((i) => i.text)).toEqual(["er"]);
  });

  it("`search` filter is case-insensitive substring match", async () => {
    setupSession();
    seedConsoleEntry("log", "Server started on 3000");
    seedConsoleEntry("log", "Database OK");
    const r = parseOkEnvelope<{ items: any[] }>(await getLogs.handler({ search: "DATABASE" }));
    expect(r.items.map((i) => i.text)).toEqual(["Database OK"]);
  });

  it("emits source-mapped TS file/line on the projection (not raw JS coords)", async () => {
    setupSession();
    seedConsoleEntry("log", "from TS", {
      mappedFile: "src/main.ts",
      mappedLine: 12,
      url: "http://localhost/main.js",
      lineNumber: 0, // CDP 0-based JS line
    });
    const r = parseOkEnvelope<{ items: any[] }>(await getLogs.handler({}));
    const item = r.items[0];
    expect(item.file).toBe("src/main.ts");
    expect(item.line).toBe(12);
    expect(item.js_url).toBe("http://localhost/main.js");
    // Public projection: js_line is 1-based even though the underlying
    // CDP value is 0-based.
    expect(item.js_line).toBe(1);
  });

  it("truncates message text to 1000 chars", async () => {
    setupSession();
    const big = "a".repeat(2500);
    seedConsoleEntry("log", big);
    const r = parseOkEnvelope<{ items: any[] }>(await getLogs.handler({}));
    expect(r.items[0].text.length).toBeLessThan(big.length);
    expect(r.items[0].text).toContain("…(+");
  });

  it("returns input cursor (not 0) when no items match", async () => {
    setupSession();
    seedConsoleEntry("log", "old");
    // Caller passes since=99 — no items strictly newer. Cursor must
    // round-trip the `since` so the agent can keep polling without
    // accidentally re-reading from seq=0.
    const r = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getLogs.handler({ since: 99 }),
    );
    expect(r.items).toEqual([]);
    expect(r.cursor).toBe(99);
  });
});

describe("clear_console", () => {
  it("no_session: structured error", async () => {
    setupSession({ noClient: true });
    const r = await clearLogs.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("no_session");
  });

  it("empties the buffer; subsequent get_console_logs returns nothing", async () => {
    setupSession();
    for (let i = 0; i < 3; i++) seedConsoleEntry("log", `m${i}`);
    const cleared = await clearLogs.handler({});
    expect(parseOkEnvelope(cleared)).toBe("cleared");
    const r = parseOkEnvelope<{ items: any[]; cursor: number }>(await getLogs.handler({}));
    expect(r.items).toEqual([]);
  });
});

describe("registration metadata", () => {
  it("registers exactly two console tools with non-empty descriptions", () => {
    expect(Array.from(tools.keys()).sort()).toEqual(["clear_console", "get_console_logs"]);
    for (const t of tools.values()) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
