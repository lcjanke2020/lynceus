import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "../util/errors.js";
import { log } from "../util/log.js";
import { toolJson, toolText } from "../util/format.js";

// Wrap a tool handler with consistent error handling so any thrown error
// becomes a structured `isError: true` result rather than an MCP transport error.
export function registerJsonTool<TInput extends Record<string, any>>(
  server: McpServer,
  name: string,
  description: string,
  inputShape: Record<string, any> | undefined,
  handler: (input: TInput) => Promise<unknown> | unknown,
) {
  server.registerTool(
    name,
    {
      description,
      ...(inputShape ? { inputSchema: inputShape as any } : {}),
    },
    async (args: any) => {
      try {
        const result = await handler((args ?? {}) as TInput);
        if (result === undefined) return toolText("ok");
        if (typeof result === "string") return toolText(result);
        return toolJson(result);
      } catch (e) {
        const code = e instanceof ToolError ? e.code : "internal_error";
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`tool error ${name}`, { code, msg });
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: msg }) }],
        };
      }
    },
  );
}
