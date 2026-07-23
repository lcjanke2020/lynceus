import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession } from "../session/state.js";
import { truncate } from "../util/format.js";
import { registerJsonTool } from "./_register.js";
import { sessionSchema, type SessionInput } from "./_session_input.js";

const LEVELS = ["log", "info", "warn", "error", "debug", "trace", "verbose"] as const;

export function registerConsoleTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_console_logs",
    "Query the buffered console + uncaught-exception stream. Paginate with `since` (the seq from the last call).",
    {
      since: z.number().int().nonnegative().optional(),
      level: z.enum(LEVELS).optional(),
      search: z.string().optional().describe("Substring filter on message text"),
      limit: z.number().int().positive().optional(),
      session: sessionSchema,
    },
    async (input: { since?: number; level?: typeof LEVELS[number]; search?: string; limit?: number } & SessionInput) => {
      const s = requireSession(input.session);
      const search = input.search?.toLowerCase();
      const items = s.console.query({
        since: input.since ?? 0,
        limit: input.limit ?? 100,
        filter: (e) => {
          if (input.level && e.level !== input.level) return false;
          if (search && !e.text.toLowerCase().includes(search)) return false;
          return true;
        },
      });
      return {
        cursor: items.length ? items[items.length - 1]!.seq : input.since ?? 0,
        items: items.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          level: e.level,
          source: e.source,
          text: truncate(e.text, 1000),
          file: e.mappedFile,
          line: e.mappedLine,
          column: e.mappedColumn,
          js_url: e.url,
          js_line: e.lineNumber != null ? e.lineNumber + 1 : undefined,
        })),
      };
    },
  );

  registerJsonTool(
    server,
    "clear_console",
    "Clear the buffered console stream (does not clear the browser's own console).",
    { session: sessionSchema },
    async (input: SessionInput) => {
      const s = requireSession(input.session);
      s.console.clear();
      return "cleared";
    },
  );
}
