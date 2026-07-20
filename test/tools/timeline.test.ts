import { describe, expect, it } from "vitest";
import { registry } from "../../src/session/state.js";
import { registerTimelineTools } from "../../src/tools/timeline.js";
import { TIMELINE_SESSION_DESC } from "../../src/tools/_session_input.js";
import {
  setupAdditionalSession,
  setupSession,
  autoReset,
} from "../setup.js";
import {
  captureTools,
  parseErrorEnvelope,
  parseOkEnvelope,
} from "../handler-registry.js";

autoReset();

const tools = captureTools(registerTimelineTools);
const getTimeline = tools.get("get_timeline")!;

describe("get_timeline", () => {
  it("returns no_session with no live target, including session=all", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getTimeline.handler({}))?.error).toBe(
      "no_session",
    );
    expect(
      parseErrorEnvelope(await getTimeline.handler({ session: "all" }))?.error,
    ).toBe("no_session");
  });

  it("omitted session resolves the only target and preserves its identity", async () => {
    const browser = setupSession({ label: "frontend" });
    browser.session.console.push({
      ts: 10,
      level: "warn",
      text: "only-browser",
      source: "console-api",
    });

    const result = parseOkEnvelope<{ items: any[] }>(
      await getTimeline.handler({}),
    );
    expect(result.items).toMatchObject([
      {
        event_type: "console",
        session: browser.sessionId,
        label: "frontend",
        level: "warn",
        text: "only-browser",
      },
    ]);
  });

  it("omission is ambiguous with two targets while session=all globally merges rows", async () => {
    const browser = setupSession({ label: "frontend" });
    const node = setupAdditionalSession({ kind: "node", label: "backend" });

    browser.session.console.push({
      ts: 400,
      level: "log",
      text: "browser console",
      source: "console-api",
      mappedFile: "src/ui.ts",
      mappedLine: 7,
      mappedColumn: 2,
      url: "http://localhost/ui.js",
      lineNumber: 19,
    });
    node.session.nodeOutput.push({
      ts: 100,
      stream: "stderr",
      text: "node stderr",
    });
    browser.session.network.push({
      requestId: "REQ-1",
      sessionId: "IFRAME-1",
      ts: 300,
      url: "http://localhost/api/cart",
      method: "POST",
      resourceType: "Fetch",
      status: 200,
      finished: true,
      durationMs: 12,
    });
    node.session.console.push({
      ts: 200,
      level: "info",
      text: "node console",
      source: "runtime-exception",
    });

    expect(parseErrorEnvelope(await getTimeline.handler({}))?.error).toBe(
      "ambiguous_session",
    );

    const result = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ session: "all" }),
    );
    expect(result.items.map((row) => row.event_type)).toEqual([
      "console",
      "node_output",
      "network",
      "console",
    ]);
    expect(result.items.map((row) => row.session)).toEqual([
      browser.sessionId,
      node.sessionId,
      browser.sessionId,
      node.sessionId,
    ]);
    expect(result.items.map((row) => row.seq)).toEqual(
      [...result.items.map((row) => row.seq)].sort((a, b) => a - b),
    );
    // Timestamps were deliberately out of order: registry seq, not wall-clock
    // scheduling jitter, is the authoritative merge key.
    expect(result.items.map((row) => row.ts)).toEqual([400, 100, 300, 200]);
    expect(result.cursor).toBe(result.items.at(-1).seq);

    expect(result.items[0]).toMatchObject({
      label: "frontend",
      file: "src/ui.ts",
      line: 7,
      column: 2,
      js_url: "http://localhost/ui.js",
      js_line: 20,
    });
    expect(result.items[1]).toMatchObject({
      label: "backend",
      stream: "stderr",
      text: "node stderr",
    });
    expect(result.items[2]).toEqual(
      expect.objectContaining({
        event_type: "network",
        request_id: "REQ-1",
        session_id: "IFRAME-1",
        method: "POST",
        url: "http://localhost/api/cart",
        resource_type: "Fetch",
      }),
    );
    // Timeline network rows are immutable request-start snapshots. Mutable
    // response/completion state remains get_network_requests' responsibility.
    expect(result.items[2]).not.toHaveProperty("status");
    expect(result.items[2]).not.toHaveProperty("finished");
    expect(result.items[2]).not.toHaveProperty("duration_ms");
  });

  it("an explicit session reads only that target", async () => {
    const browser = setupSession();
    const node = setupAdditionalSession({ kind: "node" });
    browser.session.console.push({
      ts: 1,
      level: "log",
      text: "browser-only",
      source: "console-api",
    });
    node.session.console.push({
      ts: 2,
      level: "log",
      text: "node-only",
      source: "console-api",
    });

    const result = parseOkEnvelope<{ items: any[] }>(
      await getTimeline.handler({ session: node.sessionId }),
    );
    expect(result.items.map((row) => row.text)).toEqual(["node-only"]);
    expect(result.items[0].session).toBe(node.sessionId);
  });

  it("filters event types and rejects an empty selection", async () => {
    const browser = setupSession();
    browser.session.console.push({
      ts: 1,
      level: "log",
      text: "console",
      source: "console-api",
    });
    browser.session.network.push({
      requestId: "R1",
      ts: 2,
      url: "http://x",
      method: "GET",
    });

    const filtered = parseOkEnvelope<{ items: any[] }>(
      await getTimeline.handler({ event_types: ["network"] }),
    );
    expect(filtered.items.map((row) => row.event_type)).toEqual(["network"]);
    expect(filtered.items[0].session_id).toBeNull();

    const error = parseErrorEnvelope(
      await getTimeline.handler({ event_types: [] }),
    );
    expect(error).toEqual({
      error: "invalid_arg",
      message:
        "event_types must contain at least one of: console, network, node_output",
    });
  });

  it("paginates forward from the earliest row after since without skipping", async () => {
    const browser = setupSession();
    for (const text of ["one", "two", "three", "four", "five"]) {
      browser.session.console.push({
        ts: 1,
        level: "log",
        text,
        source: "console-api",
      });
    }

    const first = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ limit: 2 }),
    );
    expect(first.items.map((row) => row.text)).toEqual(["one", "two"]);

    const second = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ since: first.cursor, limit: 2 }),
    );
    expect(second.items.map((row) => row.text)).toEqual(["three", "four"]);

    const third = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ since: second.cursor, limit: 2 }),
    );
    expect(third.items.map((row) => row.text)).toEqual(["five"]);

    const empty = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ since: third.cursor }),
    );
    expect(empty).toEqual({ cursor: third.cursor, items: [] });
  });

  it("paginates losslessly across interleaved buffers after per-source pre-limiting", async () => {
    const browser = setupSession();
    const node = setupAdditionalSession({ kind: "node" });
    for (let i = 0; i < 3; i += 1) {
      browser.session.console.push({
        ts: i,
        level: "log",
        text: `frontend-${i}`,
        source: "console-api",
      });
      node.session.nodeOutput.push({
        ts: i,
        stream: "stdout",
        text: `backend-${i}`,
      });
    }

    let since = 0;
    const texts: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = parseOkEnvelope<{ cursor: number; items: any[] }>(
        await getTimeline.handler({
          session: "all",
          since,
          limit: 2,
          event_types: ["console", "node_output"],
        }),
      );
      texts.push(...result.items.map((row) => row.text));
      since = result.cursor;
    }

    expect(texts).toEqual([
      "frontend-0",
      "backend-0",
      "frontend-1",
      "backend-1",
      "frontend-2",
      "backend-2",
    ]);
  });

  it("unknown explicit session returns the recovery envelope", async () => {
    setupSession();
    const error = parseErrorEnvelope(
      await getTimeline.handler({ session: "node_999999" }),
    );
    expect(error?.error).toBe("unknown_session");
    expect(error?.message).toContain("node_999999");
  });

  it("does not recycle global seq after a session closes and is replaced", async () => {
    const first = setupSession();
    const old = first.session.console.push({
      ts: 1,
      level: "log",
      text: "old-session",
      source: "console-api",
    });
    await registry.close(first.sessionId);

    const replacement = setupAdditionalSession({ kind: "browser" });
    const fresh = replacement.session.console.push({
      ts: 2,
      level: "log",
      text: "replacement-session",
      source: "console-api",
    });
    expect(fresh.seq).toBeGreaterThan(old.seq);

    const result = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await getTimeline.handler({ since: old.seq }),
    );
    expect(result.items.map((row) => row.text)).toEqual(["replacement-session"]);
    expect(result.cursor).toBe(fresh.seq);
  });
});

describe("registration metadata", () => {
  it("registers exactly get_timeline", () => {
    expect(Array.from(tools.keys())).toEqual(["get_timeline"]);
  });

  it("uses centralized session wording and qualifies cursor losslessness", () => {
    const schema = getTimeline.inputSchema as Record<
      string,
      { description?: string }
    >;
    expect(schema.session?.description).toBe(TIMELINE_SESSION_DESC);
    expect(schema.since?.description).toContain(
      "same session and event_types selection",
    );
    expect(getTimeline.description).toContain(
      "while the `session` and `event_types` selection stays unchanged",
    );
  });
});
