// MCP client wrapper that spawns `dist/index.js` as a subprocess and
// talks to it over stdio.
//
// Each trial gets its own subprocess. Isolation between trials is the
// whole point of the multi-trial median gate — if one trial's session
// state leaked into the next, a single bad pause or breakpoint would
// cascade across all 3 trials and the median gate would be wrong about
// what it's measuring.
//
// The MCP SDK already ships StdioClientTransport, so we don't write our
// own JSON-RPC framer. We do convert MCP tool definitions to the
// Anthropic-flavored shape (input_schema instead of inputSchema, etc.)
// in `toAnthropicTools()`.

import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "./anthropic.js";

// cache_control was promoted out of the Anthropic beta family, but the
// SDK type lags — the stable Tool type doesn't carry the field even
// though the wire format accepts it. Define a local extension so our
// tool table can tag the last entry without resorting to
// `as unknown as Tool` at the call site.
//
// SDK pin as of this PR: @anthropic-ai/sdk ^0.30.1 (2026-05). Revisit
// this shim when bumping the SDK — drop it once Tool carries the field.
type ToolWithCache = Tool & { cache_control?: { type: "ephemeral" } };

export interface McpSubprocess {
  client: Client;
  tools: McpTool[];
  /** Convenience: Anthropic-flavored tool definitions, cache-control set
   *  on the LAST entry only. Plan rev 3 Cursor L-1. */
  anthropicTools: Tool[];
  /** Stop the server cleanly. */
  close(): Promise<void>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface SpawnOpts {
  /** Path to the built MCP server entry (dist/index.js by default). */
  serverPath?: string;
  /** Env to pass to the subprocess. Inherits process.env by default. */
  env?: Record<string, string>;
  /** stderr handler — by default streams to process.stderr. Tests can
   *  override to capture for inspection. */
  onStderr?: (chunk: Buffer) => void;
}

export async function spawnMcpServer(opts: SpawnOpts = {}): Promise<McpSubprocess> {
  const serverPath = opts.serverPath ?? "dist/index.js";
  // StdioClientTransport's env type is `Record<string, string>`, but
  // process.env can carry `undefined` values. Filter them out so TS is
  // happy and the subprocess doesn't see the literal string "undefined".
  // Also drop ANTHROPIC_API_KEY — the cdp-mcp server never needs it,
  // and forwarding it widens the blast radius if the server ever logs
  // env or its child process does (PR #15 review).
  const ENV_DENYLIST = new Set(["ANTHROPIC_API_KEY"]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !ENV_DENYLIST.has(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    env[k] = v;
  }

  // StdioClientTransport takes a command + args and manages the child
  // process itself. We don't spawn separately — that would double-spawn.
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
    env,
  });

  // Surface stderr — the MCP server uses stderr for its log output, so
  // burying it would make debug cycles painful.
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer) => {
      if (opts.onStderr) opts.onStderr(chunk);
      else process.stderr.write(chunk);
    });
  }

  const client = new Client(
    { name: "cdp-mcp-evals", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as McpTool["inputSchema"],
  }));

  return {
    client,
    tools,
    anthropicTools: toAnthropicTools(tools),
    async close() {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Convert MCP tool definitions to Anthropic's tools shape + tag the
 *  LAST entry with cache_control so the full tool catalog (~5K tokens
 *  measured on cdp-mcp's current 45 tools — was estimated at ~40K but
 *  measured from a real trace) hits the cache on every trial after the
 *  first. Comfortably above Anthropic's ~1024-token cache breakpoint
 *  minimum, so this marker IS effective even when paired with a short
 *  scenario systemPromptOverride. */
export function toAnthropicTools(mcp: McpTool[]): Tool[] {
  const out: ToolWithCache[] = mcp.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema,
  }));
  if (out.length > 0) {
    out[out.length - 1] = {
      ...out[out.length - 1]!,
      cache_control: { type: "ephemeral" },
    };
  }
  return out;
}

/** Call a tool via the MCP client. Returns the structured content +
 *  whether it was reported as an error. */
export async function callMcpTool(
  client: Client,
  name: string,
  input: unknown,
): Promise<{ isError: boolean; content: unknown; raw: unknown }> {
  const res = await client.callTool({
    name,
    arguments: (input ?? {}) as Record<string, unknown>,
  });
  const content = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  // The cdp-mcp tool envelope is JSON in the first text block.
  const first = content[0];
  let parsed: unknown = first?.text;
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      parsed = JSON.parse(first.text);
    } catch {
      // text-only sentinel ("ok", "removed", etc.) — return as-is
      parsed = first.text;
    }
  }
  return {
    isError: Boolean((res as { isError?: boolean }).isError),
    content: parsed,
    raw: res,
  };
}
