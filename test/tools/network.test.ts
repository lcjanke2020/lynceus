import { describe, it, expect } from "vitest";
import { requireSession } from "../../src/session/state.js";
import { registerNetworkTools } from "../../src/tools/network.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerNetworkTools);
const list = tools.get("get_network_requests")!;
const reqBody = tools.get("get_request_body")!;
const resBody = tools.get("get_response_body")!;

const seedReq = (
  requestId: string,
  url: string,
  patch: Partial<{
    method: string;
    resourceType: string;
    status: number;
    statusText: string;
    mimeType: string;
    fromCache: boolean;
    durationMs: number;
    failureReason: string;
    finished: boolean;
    sessionId: string;
  }> = {},
) => {
  requireSession().network.push({
    requestId,
    ts: Date.now(),
    url,
    method: patch.method ?? "GET",
    ...patch,
  });
};

describe("get_network_requests", () => {
  it("no_session error envelope", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await list.handler({}))?.error).toBe("no_session");
  });

  it("returns buffered entries with the projected shape (session_id null for root)", async () => {
    setupSession();
    seedReq("r1", "http://x/a", { status: 200, mimeType: "text/html", finished: true });
    const r = parseOkEnvelope<{ items: any[] }>(await list.handler({}));
    expect(r.items).toHaveLength(1);
    const item = r.items[0];
    expect(item.request_id).toBe("r1");
    expect(item.url).toBe("http://x/a");
    expect(item.status).toBe(200);
    expect(item.mime_type).toBe("text/html");
    expect(item.finished).toBe(true);
    // Critical: session_id MUST be `null` (not undefined) for root entries
    // — undefined drops out of JSON serialization, leaving the agent
    // nothing to round-trip back to get_request_body / get_response_body.
    expect(item.session_id).toBeNull();
  });

  it("session_id is preserved for child sessions", async () => {
    setupSession();
    seedReq("r2", "http://x/b", { sessionId: "IF1" });
    const r = parseOkEnvelope<{ items: any[] }>(await list.handler({}));
    expect(r.items[0].session_id).toBe("IF1");
  });

  it("filters by status, type, url substring, and finished", async () => {
    setupSession();
    seedReq("r1", "http://x/page", { status: 200, resourceType: "Document", finished: true });
    seedReq("r2", "http://x/api/users", { status: 404, resourceType: "Fetch", finished: true });
    seedReq("r3", "http://x/api/in-flight", { resourceType: "Fetch", finished: false });

    const byStatus = parseOkEnvelope<{ items: any[] }>(await list.handler({ status: 404 }));
    expect(byStatus.items.map((i) => i.request_id)).toEqual(["r2"]);

    const byType = parseOkEnvelope<{ items: any[] }>(await list.handler({ type: "Fetch" }));
    expect(byType.items.map((i) => i.request_id)).toEqual(["r2", "r3"]);

    const byUrl = parseOkEnvelope<{ items: any[] }>(await list.handler({ url_match: "users" }));
    expect(byUrl.items.map((i) => i.request_id)).toEqual(["r2"]);

    const finishedOnly = parseOkEnvelope<{ items: any[] }>(await list.handler({ finished: true }));
    expect(finishedOnly.items.map((i) => i.request_id)).toEqual(["r1", "r2"]);

    const inFlightOnly = parseOkEnvelope<{ items: any[] }>(await list.handler({ finished: false }));
    expect(inFlightOnly.items.map((i) => i.request_id)).toEqual(["r3"]);
  });

  it("cursor + since paginate strictly", async () => {
    setupSession();
    for (let i = 0; i < 4; i++) seedReq(`r${i}`, `http://x/${i}`);
    const first = parseOkEnvelope<{ cursor: number; items: any[] }>(
      await list.handler({ limit: 2 }),
    );
    expect(first.items.map((i) => i.request_id)).toEqual(["r2", "r3"]);
    expect(first.cursor).toBe(first.items[first.items.length - 1].seq);
    // No newer items.
    const empty = parseOkEnvelope<{ items: any[] }>(await list.handler({ since: first.cursor }));
    expect(empty.items).toEqual([]);
  });
});

describe("get_request_body", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await reqBody.handler({ request_id: "r1" }))?.error).toBe("no_session");
  });

  it("happy path: returns postData truncated to max_chars", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/a");
    fake.respond("Network.getRequestPostData", () => ({ postData: "a".repeat(50) }));
    const r = parseOkEnvelope<{ body: string; truncated_at: number | null; total_length: number }>(
      await reqBody.handler({ request_id: "r1", max_chars: 10 }),
    );
    expect(r.body).toContain("…(+");
    expect(r.truncated_at).toBe(10);
    expect(r.total_length).toBe(50);
  });

  it("strict session routing: omitted session_id targets root only (does not fall through to child entries)", async () => {
    // Codex-style regression guard: the permissive fallback used to pick
    // the most-recent entry with a matching requestId regardless of
    // sessionId, routing root-issued body fetches to a child entry's
    // session. Verify that omitted session_id matches only the root entry.
    const { fake } = setupSession();
    seedReq("r1", "http://x/iframe", { sessionId: "IF1" });
    seedReq("r1", "http://x/root"); // root entry, same requestId
    fake.respond("Network.getRequestPostData", (_p, sid) => ({ postData: `ok-${sid ?? "root"}` }));
    const r = parseOkEnvelope<{ body: string }>(await reqBody.handler({ request_id: "r1" }));
    // Without session_id, must hit the root entry and route with sessionId=undefined.
    expect(r.body).toBe("ok-root");
  });

  it("explicit session_id routes to the child Network agent", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/iframe", { sessionId: "IF1" });
    fake.respond("Network.getRequestPostData", (_p, sid) => ({ postData: `ok-${sid}` }));
    const r = parseOkEnvelope<{ body: string }>(await reqBody.handler({ request_id: "r1", session_id: "IF1" }));
    expect(r.body).toBe("ok-IF1");
  });

  it("CDP error is caught and surfaced as { body: null, error } (not a thrown ToolError)", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/a");
    fake.respond("Network.getRequestPostData", () => {
      throw new Error("No request data found");
    });
    const r = parseOkEnvelope<{ body: null; error: string }>(await reqBody.handler({ request_id: "r1" }));
    expect(r.body).toBeNull();
    expect(r.error).toContain("No request data found");
  });
});

describe("get_response_body", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await resBody.handler({ request_id: "r1" }))?.error).toBe("no_session");
  });

  it("text body is truncated to max_chars", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/a", { finished: true });
    fake.respond("Network.getResponseBody", () => ({ body: "x".repeat(8000), base64Encoded: false }));
    const r = parseOkEnvelope<{ body: string; truncated_at: number | null; total_length: number }>(
      await resBody.handler({ request_id: "r1", max_chars: 100 }),
    );
    expect(r.truncated_at).toBe(100);
    expect(r.total_length).toBe(8000);
    expect(r.body).toContain("…(+");
  });

  it("base64 body is returned WHOLE (truncation would corrupt binary tail)", async () => {
    // Critical regression guard: the old behavior truncated base64 with
    // "…(+N chars)" — the suffix contains alphanumerics + `+` that lenient
    // base64 decoders happily consume, silently corrupting the tail bytes
    // of any binary response (PNG / wasm / font).
    const { fake } = setupSession();
    seedReq("r1", "http://x/img", { finished: true });
    const big = "a".repeat(20000); // 20K chars of base64
    fake.respond("Network.getResponseBody", () => ({ body: big, base64Encoded: true }));
    const r = parseOkEnvelope<{ body: string; base64_encoded: boolean; truncated_at: number | null }>(
      await resBody.handler({ request_id: "r1", max_chars: 100 }),
    );
    expect(r.base64_encoded).toBe(true);
    expect(r.body).toBe(big); // unchanged, full length
    expect(r.truncated_at).toBeNull();
  });

  it("CDP error is caught and surfaced as { body: null, error }", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/a");
    fake.respond("Network.getResponseBody", () => {
      throw new Error("No data found for resource");
    });
    const r = parseOkEnvelope<{ body: null; error: string }>(await resBody.handler({ request_id: "r1" }));
    expect(r.body).toBeNull();
    expect(r.error).toContain("No data found");
  });

  it("session_id round-trips into the CDP send call", async () => {
    const { fake } = setupSession();
    seedReq("r1", "http://x/sw", { sessionId: "SW1" });
    fake.respond("Network.getResponseBody", () => ({ body: "ok", base64Encoded: false }));
    fake.clearSentCalls();
    await resBody.handler({ request_id: "r1", session_id: "SW1" });
    const call = fake.sentCalls.find((c) => c.method === "Network.getResponseBody");
    expect(call?.sessionId).toBe("SW1");
  });
});

describe("registration metadata", () => {
  it("registers exactly the three network tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "get_network_requests",
      "get_request_body",
      "get_response_body",
    ]);
  });
});
