import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession, requireCapable } from "../session/state.js";
import { truncate } from "../util/format.js";
import { registerJsonTool } from "./_register.js";
import { sessionSchema, type SessionInput } from "./_session_input.js";

// Pull-based stdout/stderr reader for lynceus-owned Node children.
// Deliberately separate from get_console_logs: that tool surfaces
// Runtime.consoleAPICalled events captured by the V8 inspector; this one
// surfaces raw process stdio that the inspector never sees. The two are
// complementary, not overlapping — a `console.log("hi")` inside the
// debuggee shows up in get_console_logs; an `npm install ...` subprocess
// or a bare `process.stdout.write(...)` shows up here.
//
// Buffer is populated only when lynceus launched the Node child itself
// (`launch_node`). `attach_node` sessions leave the buffer empty because
// we don't own the stdio of a pre-existing process.

const STREAMS = ["stdout", "stderr"] as const;

export function registerNodeOutputTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_node_output",
    "Query the buffered stdout/stderr from a lynceus-launched Node process (launch_node). Paginate with `since` (the seq from the last call). Populated only for launch_node sessions; attach_node returns an empty list because lynceus doesn't own the child's stdio. Separate from get_console_logs — that's the V8 inspector's Runtime.consoleAPICalled stream; this is the OS-level pipe.",
    {
      since: z.number().int().nonnegative().optional(),
      stream: z.enum(STREAMS).optional().describe("Filter to one stream"),
      search: z.string().optional().describe("Substring filter on line text"),
      limit: z.number().int().positive().optional(),
      session: sessionSchema,
    },
    async (input: {
      since?: number;
      stream?: typeof STREAMS[number];
      search?: string;
      limit?: number;
    } & SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "get_node_output");
      const search = input.search?.toLowerCase();
      const items = s.nodeOutput.query({
        since: input.since ?? 0,
        limit: input.limit ?? 100,
        filter: (e) => {
          if (input.stream && e.stream !== input.stream) return false;
          if (search && !e.text.toLowerCase().includes(search)) return false;
          return true;
        },
      });
      return {
        cursor: items.length ? items[items.length - 1]!.seq : input.since ?? 0,
        items: items.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          stream: e.stream,
          text: truncate(e.text, 1000),
        })),
      };
    },
  );
}
