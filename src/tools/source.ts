import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession } from "../session/state.js";
import { mapOriginalToGenerated } from "../sourcemap/store.js";
import { registerJsonTool } from "./_register.js";

export function registerSourceTools(server: McpServer) {
  registerJsonTool(
    server,
    "list_scripts",
    "List scripts the browser has parsed in the active page, with source-map status.",
    {
      mapped_only: z.boolean().optional().describe("Default true: only return scripts whose map loaded"),
      url_includes: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
    async (input: { mapped_only?: boolean; url_includes?: string; limit?: number }) => {
      const s = requireSession();
      const mappedOnly = input.mapped_only ?? true;
      let scripts = s.scripts.all().filter((sc) => !!sc.url);
      if (mappedOnly) scripts = scripts.filter((sc) => !!sc.consumer);
      if (input.url_includes) scripts = scripts.filter((sc) => sc.url.includes(input.url_includes!));
      if (input.limit) scripts = scripts.slice(0, input.limit);
      return scripts.map((sc) => ({
        script_id: sc.scriptId,
        // session_id disambiguates root vs worker/iframe entries with
        // colliding scriptIds (CDP scriptIds are per-Debugger-agent). null
        // = root; survives JSON serialization, unlike undefined.
        session_id: sc.sessionId ?? null,
        url: sc.url,
        source_map_url: sc.sourceMapURL,
        has_map: !!sc.consumer,
        load_error: sc.loadError,
        original_sources: sc.sources?.slice(0, 30),
        original_source_count: sc.sources?.length ?? 0,
      }));
    },
  );

  registerJsonTool(
    server,
    "get_script_source",
    "Fetch the raw generated (JS) source text for a script by CDP script ID. Pass `session_id` from list_scripts to fetch a worker/iframe script — CDP scriptIds are per-Debugger-agent, so omitting session_id always routes to root.",
    {
      script_id: z.string(),
      session_id: z.string().nullable().optional().describe("From list_scripts. null or omitted = root."),
    },
    async (input: { script_id: string; session_id?: string | null }) => {
      const s = requireSession();
      // null is the explicit "root" sentinel from the projection; CDP wants undefined.
      const sid = input.session_id ?? undefined;
      const result = await s.client!.send(
        "Debugger.getScriptSource",
        { scriptId: input.script_id },
        sid,
      );
      return { script_id: input.script_id, session_id: sid ?? null, source: result.scriptSource };
    },
  );

  registerJsonTool(
    server,
    "resolve_source_position",
    "Translate a TS source coord into the JS (generated) coords CDP would use. Useful for diagnosing why a breakpoint didn't bind.",
    {
      file: z.string(),
      line: z.number().int().positive().describe("1-based"),
      column: z.number().int().nonnegative().optional(),
    },
    async (input: { file: string; line: number; column?: number }) => {
      const s = requireSession();
      const candidates = await mapOriginalToGenerated(s.scripts, input.file, input.line, input.column ?? 0);
      return {
        query: { file: input.file, line: input.line, column: input.column ?? 0 },
        candidates: candidates.map((c) => ({
          script_id: c.scriptId,
          session_id: c.sessionId ?? null,
          script_url: c.scriptUrl,
          line: c.lineNumber + 1, // public is 1-based
          column: c.columnNumber,
        })),
      };
    },
  );
}
