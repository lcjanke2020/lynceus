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

// Vendor/eval credentials that must NEVER reach the spawned lynceus
// subprocess. The threat model has two layers:
//
//   1. Log/blast-radius widening: lynceus's server has no need for any
//      of these. Forwarding them grows the surface area for an
//      accidental log dump (the original concern from an upstream review).
//   2. Debuggee exfiltration (raised by an upstream Codex high-severity review):
//      a Node `launch_node` debuggee inherits the MCP subprocess env by
//      default and can `evaluate` `process.env.<credential>` directly.
//      The result then persists into the trace via the tool_result
//      entry, so a single Node eval trial under, e.g., EVAL_PROVIDER=
//      openai/vertex would write the vendor key to disk in cleartext.
//
// Defense-in-depth: an explicit name set covers the vendors we know
// about today, plus a regex catch-all over common credential suffixes
// (*_API_KEY, *_ACCESS_KEY[_ID], *_SECRET[_KEY], *_PRIVATE_KEY, *_TOKEN,
// *_CREDENTIALS, *_PASSWORD) so future keys of those shapes are blocked
// without a code change. The
// filter applies to BOTH inherited process.env AND caller-supplied
// `opts.env` — the latter is plumbed by the harness runner and should
// only carry config (CHROME_PATH today); we refuse to be the path that
// re-introduces a credential just because the caller forgot.
const ENV_DENYLIST_EXPLICIT = new Set<string>([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "EVAL_LM_STUDIO_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]);
const ENV_DENYLIST_PATTERN =
  /_API_KEY$|_ACCESS_KEY$|_ACCESS_KEY_ID$|_SECRET$|_SECRET_KEY$|_PRIVATE_KEY$|_TOKEN$|_CREDENTIALS$|_PASSWORD$/i;

function isCredentialEnvName(name: string): boolean {
  return ENV_DENYLIST_EXPLICIT.has(name) || ENV_DENYLIST_PATTERN.test(name);
}

/** Pure helper: build the env map the lynceus subprocess will receive.
 *
 *  - Drops any value that's not a string (process.env can carry
 *    `undefined`; StdioClientTransport's env type is
 *    `Record<string, string>`).
 *  - Drops any name in the credential denylist (explicit set OR regex
 *    pattern) — applied to BOTH inherited and caller-supplied entries.
 *  - opts_env merges on top of inherited env, BUT denylisted opts_env
 *    keys are still scrubbed; if you need to forward a name that
 *    matches the pattern, change the pattern, don't bypass it.
 *
 *  Exported for L2 unit testing — the full transport-level path is
 *  covered by L3 e2e tests against a real subprocess. */
export function buildSanitizedEnv(
  process_env: NodeJS.ProcessEnv,
  opts_env: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process_env)) {
    if (typeof v === "string" && !isCredentialEnvName(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts_env ?? {})) {
    if (!isCredentialEnvName(k)) env[k] = v;
  }
  return env;
}

export async function spawnMcpServer(opts: SpawnOpts = {}): Promise<McpSubprocess> {
  const serverPath = opts.serverPath ?? "dist/index.js";
  const env = buildSanitizedEnv(process.env, opts.env);

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
    { name: "lynceus-evals", version: "0.1.0" },
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
 *  measured on lynceus's current 53 tools — was estimated at ~40K but
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
  // The lynceus tool envelope is JSON in the first text block.
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
