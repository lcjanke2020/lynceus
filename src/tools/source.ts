import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession } from "../session/state.js";
import { mapOriginalToGenerated } from "../sourcemap/store.js";
import { readOriginalSource } from "../sourcemap/original-source.js";
import { ToolError } from "../util/errors.js";
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
    "get_source",
    "Fetch the ORIGINAL TypeScript source for a file, resolved through source maps. Use this — not get_script_source — to read line numbers for set_breakpoint, which takes TS coordinates: get_script_source returns compiled JS whose line numbers do NOT correspond to set_breakpoint's. Matches by TS path or fragment (e.g. src/foo.ts), like set_breakpoint / resolve_source_position. Lines are 1-based and are exactly the coordinates set_breakpoint expects.",
    {
      file: z.string().describe("TS file path or fragment (e.g. src/foo.ts)"),
      session_id: z
        .string()
        .nullable()
        .optional()
        .describe("From list_scripts, to disambiguate a worker/iframe copy. null or omitted = root."),
    },
    async (input: { file: string; session_id?: string | null }) => {
      const s = requireSession();
      const res = await readOriginalSource(s, input.file, input.session_id);
      if (!res.ok) {
        const hint =
          res.reason === "no_content"
            ? `A source-mapped script references '${input.file}', but its original source is neither embedded in the map (no sourcesContent) nor readable from disk (non-loopback session, or the file moved). Use get_script_source for the compiled JS, or resolve_source_position to map a TS coordinate to JS.`
            : `No source-mapped script references '${input.file}'. Try list_scripts to see what's loaded (see each entry's original_sources).`;
        throw new ToolError("no_source", hint);
      }
      const { value } = res;
      // 1-based line count; an empty file is 0 lines (not 1).
      const lineCount = value.content.length === 0 ? 0 : value.content.split("\n").length;
      return {
        file: value.file,
        script_id: value.scriptId,
        session_id: value.sessionId,
        script_url: value.scriptUrl,
        // "source_map" = embedded sourcesContent; "disk" = read from the local .ts.
        origin: value.origin,
        line_count: lineCount,
        source: value.content,
      };
    },
  );

  registerJsonTool(
    server,
    "get_script_source",
    "Fetch the raw generated (JS) source text for a script by CDP script ID. NOTE: this is COMPILED JS — its line numbers are NOT set_breakpoint coordinates (set_breakpoint takes TypeScript lines). To read TS line numbers use get_source; to translate a TS coordinate to JS use resolve_source_position. Pass `session_id` from list_scripts to fetch a worker/iframe script — CDP scriptIds are per-Debugger-agent, so omitting session_id always routes to root.",
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
