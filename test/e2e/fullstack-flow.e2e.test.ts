// L3 dual-session acceptance flow (LEO-116): one browser and one
// lynceus-owned Node process stay live while a single request crosses from a
// source-mapped vanilla page into a source-mapped Node HTTP handler. Every
// session-scoped call is explicitly addressed — raced waits and merged
// timelines belong to LEO-365 / the next branch PR.

import { describe, it, expect } from "vitest";
import {
  attachToTestChrome,
  buildToolMap,
  call,
  fullstackAppUrl,
} from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

// These are executable TypeScript lines in the two fixture entries. Keeping
// them named here makes source-coordinate drift obvious in review.
const FRONTEND_BREAKPOINT_LINE = 13;
const BACKEND_BREAKPOINT_LINE = 7;
const API_LISTENING_RE = /fullstack-api listening on http:\/\/127\.0\.0\.1:(\d+)/;

interface PauseSummary {
  hit_breakpoint_ids: string[];
  call_stack: Array<{ file: string; line: number }>;
}

interface BreakpointResult {
  id: string;
  status: string;
  binding_count: number;
  resolved_locations: Array<{ file: string; line: number; column: number }>;
}

async function waitForApiPort(session: string): Promise<number> {
  return await waitFor(
    async () => {
      const output = await call<{
        items: Array<{ stream: string; text: string }>;
      }>(tools, "get_node_output", {
        session,
        stream: "stdout",
        search: "fullstack-api listening",
      });
      for (const item of output.items) {
        const match = API_LISTENING_RE.exec(item.text);
        if (match) return Number(match[1]);
      }
      return null;
    },
    { timeoutMs: 10_000, describe: "port-0 fullstack API listening banner" },
  );
}

describe("full-stack flow (e2e)", () => {
  it("breakpoints and inspects both sides of one browser → Node request", async () => {
    // Backend first: --inspect-brk gives us a deterministic setup window in
    // which its source map is loaded and the route breakpoint can bind before
    // the HTTP server starts accepting requests.
    const backend = await call<{
      session: string;
      label: string | null;
      pid: number;
      port: number;
    }>(tools, "launch_node", {
      script: fixtureScript("fullstack-api"),
      label: "backend",
    });
    expect(backend.session).toMatch(/^node_\d+$/);
    expect(backend.label).toBe("backend");
    expect(backend.pid).toBeGreaterThan(0);

    const entryPause = await call<PauseSummary>(tools, "wait_for_pause", {
      session: backend.session,
      timeout_ms: 10_000,
    });
    expect(entryPause.hit_breakpoint_ids).toEqual([]);
    expect(entryPause.call_stack[0]!.file).toMatch(/\.ts$/);

    const backendBp = await call<BreakpointResult>(tools, "set_breakpoint", {
      session: backend.session,
      file: "fullstack-api.ts",
      line: BACKEND_BREAKPOINT_LINE,
    });
    expect(backendBp.status).toBe("set");
    expect(backendBp.binding_count).toBeGreaterThanOrEqual(1);
    expect(backendBp.resolved_locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringMatching(/fullstack-api\.ts$/),
          line: BACKEND_BREAKPOINT_LINE,
        }),
      ]),
    );

    expect(
      await call<string>(tools, "resume", { session: backend.session }),
    ).toBe("resumed");
    const apiPort = await waitForApiPort(backend.session);
    expect(apiPort).toBeGreaterThan(0);

    // Add the browser beside the still-live Node target and navigate its
    // dedicated static page to the port the backend actually selected.
    const frontend = await attachToTestChrome(tools, { label: "frontend" });
    expect(frontend.session).toMatch(/^browser_\d+$/);
    expect(frontend.label).toBe("frontend");
    await call(tools, "navigate", {
      session: frontend.session,
      url: fullstackAppUrl(apiPort),
      wait: "load",
    });

    const live = await call<{
      sessions: Array<{
        session: string;
        kind: "browser" | "node";
        label: string | null;
        paused: boolean;
      }>;
    }>(tools, "list_sessions");
    expect(live.sessions).toHaveLength(2);
    expect(live.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session: backend.session,
          kind: "node",
          label: "backend",
          paused: false,
        }),
        expect.objectContaining({
          session: frontend.session,
          kind: "browser",
          label: "frontend",
          paused: false,
        }),
      ]),
    );

    const frontendBp = await call<BreakpointResult>(tools, "set_breakpoint", {
      session: frontend.session,
      file: "fullstack.ts",
      line: FRONTEND_BREAKPOINT_LINE,
    });
    expect(frontendBp.status).toBe("set");
    expect(frontendBp.binding_count).toBeGreaterThanOrEqual(1);
    expect(frontendBp.resolved_locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: expect.stringMatching(/fullstack\.ts$/),
          line: FRONTEND_BREAKPOINT_LINE,
        }),
      ]),
    );

    // Input.dispatchMouseEvent remains pending while Chrome is paused. Keep
    // its rejection handled, observe the scoped pause, then settle it after
    // both sides resume (the same ordering the interview demo rehearses).
    const clickResult = call(tools, "click", {
      session: frontend.session,
      selector: "#request-backend",
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    const frontendPause = await call<PauseSummary>(tools, "wait_for_pause", {
      session: frontend.session,
      timeout_ms: 10_000,
    });
    expect(frontendPause.hit_breakpoint_ids).toContain(frontendBp.id);
    expect(frontendPause.call_stack[0]).toEqual(
      expect.objectContaining({
        file: expect.stringMatching(/fullstack\.ts$/),
        line: FRONTEND_BREAKPOINT_LINE,
      }),
    );
    const requestUrl = await call<{ value?: string }>(tools, "evaluate", {
      session: frontend.session,
      frame_index: 0,
      expression: "requestUrl",
      return_by_value: true,
    });
    expect(requestUrl.value).toBe(`http://127.0.0.1:${apiPort}/api/x`);

    expect(
      await call<string>(tools, "resume", { session: frontend.session }),
    ).toBe("resumed");

    // The browser's fetch now crosses into the independently-paused Node
    // target. This scoped wait must not observe or mutate the browser session.
    const backendPause = await call<PauseSummary>(tools, "wait_for_pause", {
      session: backend.session,
      timeout_ms: 10_000,
    });
    expect(backendPause.hit_breakpoint_ids).toContain(backendBp.id);
    expect(backendPause.call_stack[0]).toEqual(
      expect.objectContaining({
        file: expect.stringMatching(/fullstack-api\.ts$/),
        line: BACKEND_BREAKPOINT_LINE,
      }),
    );
    const requestPath = await call<{ value?: string }>(tools, "evaluate", {
      session: backend.session,
      frame_index: 0,
      expression: "requestPath",
      return_by_value: true,
    });
    expect(requestPath.value).toBe("/api/x");

    expect(
      await call<string>(tools, "resume", { session: backend.session }),
    ).toBe("resumed");

    const click = await clickResult;
    if ("error" in click) throw click.error;

    await waitFor(
      async () => {
        const html = await call<{ html: string }>(tools, "get_element_html", {
          session: frontend.session,
          selector: "#result",
        });
        return html.html.includes("backend-ok:/api/x") ? html : null;
      },
      { timeoutMs: 10_000, describe: "browser renders the backend response" },
    );

    const apiRequest = await waitFor(
      async () => {
        const network = await call<{
          items: Array<{
            request_id: string;
            session_id: string | null;
            url: string;
            status?: number;
            finished: boolean;
          }>;
        }>(tools, "get_network_requests", {
          session: frontend.session,
          url_match: "/api/x",
        });
        return (
          network.items.find(
            (item) => item.url.endsWith("/api/x") && item.status === 200 && item.finished,
          ) ?? null
        );
      },
      { timeoutMs: 10_000, describe: "finished browser /api/x request" },
    );
    const response = await call<{
      base64_encoded: boolean;
      body: string;
    }>(tools, "get_response_body", {
      session: frontend.session,
      request_id: apiRequest.request_id,
      session_id: apiRequest.session_id,
    });
    const body = response.base64_encoded
      ? Buffer.from(response.body, "base64").toString("utf8")
      : response.body;
    expect(JSON.parse(body)).toEqual({ message: "backend-ok", requestPath: "/api/x" });

    expect(
      await call(tools, "close_session", { session: backend.session }),
    ).toEqual({ session: backend.session, label: "backend", status: "closed" });
    expect(
      await call(tools, "close_session", { session: frontend.session }),
    ).toEqual({ session: frontend.session, label: "frontend", status: "closed" });
    expect(await call(tools, "list_sessions")).toEqual({ sessions: [] });
  });
});
