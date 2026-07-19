import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession, requireCapable } from "../session/state.js";
import { truncate } from "../util/format.js";
import { registerJsonTool } from "./_register.js";
import {
  childSessionIdSchema,
  sessionSchema,
  withChildSessionDisambiguation,
  type SessionInput,
} from "./_session_input.js";

export function registerNetworkTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_network_requests",
    "Query buffered network requests. Paginate with `since`. Bodies are NOT included — fetch via get_request_body/get_response_body.",
    {
      since: z.number().int().nonnegative().optional(),
      status: z.number().int().optional(),
      type: z.string().optional().describe("e.g. Fetch, XHR, Document, Script"),
      url_match: z.string().optional().describe("Substring filter"),
      finished: z.boolean().optional().describe("If true, only return entries whose lifecycle has completed (loaded OR failed — also check the `failure` field before calling get_response_body)"),
      limit: z.number().int().positive().optional(),
      session: sessionSchema,
    },
    async (input: { since?: number; status?: number; type?: string; url_match?: string; finished?: boolean; limit?: number } & SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "get_network_requests");
      const match = input.url_match;
      const items = s.network.query({
        since: input.since ?? 0,
        limit: input.limit ?? 50,
        filter: (e) => {
          if (input.status !== undefined && e.status !== input.status) return false;
          if (input.type && e.resourceType !== input.type) return false;
          if (match && !e.url.includes(match)) return false;
          if (input.finished === true && !e.finished) return false;
          if (input.finished === false && e.finished) return false;
          return true;
        },
      });
      return {
        cursor: items.length ? items[items.length - 1]!.seq : input.since ?? 0,
        items: items.map((e) => ({
          seq: e.seq,
          request_id: e.requestId,
          // session_id is required to disambiguate when fetching the body —
          // CDP requestIds are per-Network-agent, so two iframes can both
          // emit requestId="123", and the root↔child case has the same
          // collision risk. Emit `null` for root (rather than undefined) so
          // the field survives JSON serialization and agents can round-trip
          // it back to get_request_body / get_response_body.
          session_id: e.sessionId ?? null,
          ts: e.ts,
          method: e.method,
          url: e.url,
          type: e.resourceType,
          status: e.status,
          status_text: e.statusText,
          mime_type: e.mimeType,
          from_cache: e.fromCache,
          finished: !!e.finished,
          duration_ms: e.durationMs,
          failure: e.failureReason,
        })),
      };
    },
  );

  registerJsonTool(
    server,
    "get_request_body",
    withChildSessionDisambiguation(
      "Fetch the request body for a request ID. Often empty for GETs. Pass `session_id` from the get_network_requests item to disambiguate when child sessions have colliding request_ids. `null` = root.",
    ),
    {
      request_id: z.string(),
      session_id: childSessionIdSchema,
      max_chars: z.number().int().positive().optional(),
      session: sessionSchema,
    },
    async (input: { request_id: string; session_id?: string | null; max_chars?: number } & SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "get_request_body");
      const max = input.max_chars ?? 4000;
      // Normalize null→undefined for CDP. After normalization, sid is the
      // session the agent intends (undefined = root, string = child).
      const sid = input.session_id ?? undefined;
      const entry = findEntry(s, input.request_id, sid);
      try {
        const r = await s.client!.send(
          "Network.getRequestPostData",
          { requestId: input.request_id },
          sid ?? entry?.sessionId,
        );
        const body = r.postData ?? "";
        return {
          request_id: input.request_id,
          body: truncate(body, max),
          truncated_at: body.length > max ? max : null,
          total_length: body.length,
        };
      } catch (e) {
        return { request_id: input.request_id, body: null, error: String(e) };
      }
    },
  );

  registerJsonTool(
    server,
    "get_response_body",
    withChildSessionDisambiguation(
      "Fetch the response body for a request ID. Only safe when `finished: true` AND `failure` is absent in get_network_requests — failed requests are also `finished: true` but have no body. Pass `session_id` from the get_network_requests item to disambiguate cross-session request_id collisions. Binary payloads (base64_encoded=true) are returned as a clean base64 string — call Buffer.from(body, 'base64') to get raw bytes. Server does NOT decode binary to UTF-8 (which would corrupt PNGs/fonts/wasm/etc.) and does NOT truncate base64 bodies (truncation appended text characters that were inside the base64 alphabet, silently corrupting the tail bytes).",
    ),
    {
      request_id: z.string(),
      session_id: childSessionIdSchema,
      max_chars: z.number().int().positive().optional().describe("Only applied to TEXT responses; base64 payloads are returned in full"),
      session: sessionSchema,
    },
    async (input: { request_id: string; session_id?: string | null; max_chars?: number } & SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "get_response_body");
      const max = input.max_chars ?? 4000;
      const sid = input.session_id ?? undefined;
      const entry = findEntry(s, input.request_id, sid);
      try {
        const r = await s.client!.send(
          "Network.getResponseBody",
          { requestId: input.request_id },
          sid ?? entry?.sessionId,
        );
        const body = r.body;
        // Text path: truncate freely. Base64 path: NEVER truncate — the old
        // truncate() suffix "…(+N chars)" contains characters (digits, letters,
        // `+`) that Node's lenient base64 decoder happily consumes as extra
        // bytes, silently corrupting the tail of any binary response.
        // Callers wanting more than the default should pass max_chars; for
        // binary they get the whole thing.
        if (r.base64Encoded) {
          return {
            request_id: input.request_id,
            base64_encoded: true,
            body,
            truncated_at: null,
            total_length: body.length,
          };
        }
        return {
          request_id: input.request_id,
          base64_encoded: false,
          body: truncate(body, max),
          truncated_at: body.length > max ? max : null,
          total_length: body.length,
        };
      } catch (e) {
        return { request_id: input.request_id, body: null, error: String(e) };
      }
    },
  );
}

// Find the most-recent entry matching (requestId, sessionId). Strict match:
// omitted session_id means "root" (sessionId === undefined). The earlier
// permissive fallback (omitted matches any) created a root↔child collision
// hole — get_network_requests emits session_id:null for root entries
// (because JSON drops undefined), agents had no value to pass back, and the
// permissive filter then picked the most-recent matching requestId which
// could be a child entry, routing the body fetch to the wrong agent.
function findEntry(
  s: ReturnType<typeof requireSession>,
  requestId: string,
  sessionId: string | undefined,
) {
  return s.network.query({
    filter: (e) => e.requestId === requestId && (e.sessionId ?? undefined) === sessionId,
    limit: 1,
  }).pop();
}
