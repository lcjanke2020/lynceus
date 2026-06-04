// Capture a register*Tools function's tool registrations into a Map so L2
// tests can invoke handlers directly with synthetic inputs.
//
// This avoids two heavier alternatives:
//   - Adding a `getRegisteredHandlers()` debug helper to src/server.ts
//     (couples production code to a test-only concern).
//   - Reaching into McpServer's private `_registeredTools` field
//     (brittle across SDK minor versions).
//
// The captured handler is the wrapper from src/tools/_register.ts, so
// invoking it returns the full `{content: [...], isError?: boolean}`
// envelope. Tests assert on the envelope shape directly. Zod input
// validation is skipped (the SDK does it inside server.registerTool's
// own implementation); the Phase F contract test exercises that path
// via InMemoryTransport.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface CapturedTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  /**
   * Wrapped handler from registerJsonTool — returns the MCP content
   * envelope, never throws (errors come back as { isError: true,
   * content: [{type:"text", text:'{"error":"...","message":"..."}'}] }).
   */
  handler: (args: any) => Promise<{
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export type ToolRegistrar = (server: McpServer) => void;

export function captureTools(register: ToolRegistrar): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const fakeServer = {
    registerTool(name: string, opts: any, handler: any) {
      tools.set(name, {
        name,
        description: opts?.description ?? "",
        inputSchema: opts?.inputSchema,
        handler,
      });
      // Mirror what McpServer.registerTool returns (a registration handle).
      return { remove() { tools.delete(name); } };
    },
  } as unknown as McpServer;
  register(fakeServer);
  return tools;
}

/** Convenience: parse the {error, message} JSON out of an isError envelope. */
export function parseErrorEnvelope(envelope: {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}): { error: string; message: string } | null {
  if (!envelope.isError) return null;
  const first = envelope.content[0];
  if (!first || first.type !== "text") return null;
  try {
    const parsed = JSON.parse(first.text) as { error: string; message: string };
    return parsed;
  } catch {
    return null;
  }
}

/** Convenience: parse the JSON body of a successful envelope. */
export function parseOkEnvelope<T = unknown>(envelope: {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}): T {
  if (envelope.isError) {
    throw new Error(`Expected success envelope, got error: ${envelope.content[0]?.text}`);
  }
  const first = envelope.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Envelope has no text content");
  }
  // Tools may return a plain string sentinel ("ok"/"removed"/etc.) OR a
  // JSON blob. Try JSON first; on parse failure return the raw text — which
  // covers both literal-string returns AND any future sentinels added by new
  // tools without needing to extend a hardcoded list. (Earlier rev had an
  // explicit sentinel-list check before the try/catch; Opus PR #10 round-2
  // Low: the list was structurally redundant with the catch fallback.)
  const text = first.text;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
