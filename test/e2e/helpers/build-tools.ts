// Build the production tool map for L3 specs. Reuses the same captureTools
// helper as the L2 contract tests so the e2e specs drive the same handlers
// that ship — anything that passes L2 but fails L3 indicates the L2 fake
// is wrong (plan: L3 → "These tests also validate the L2 fakes are
// faithful").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureTools, type CapturedTool, parseOkEnvelope, parseErrorEnvelope } from "../../handler-registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSessionTools } from "../../../src/tools/session.js";
import { registerNavTools } from "../../../src/tools/nav.js";
import { registerSourceTools } from "../../../src/tools/source.js";
import { registerBreakpointTools } from "../../../src/tools/breakpoints.js";
import { registerExecutionTools } from "../../../src/tools/execution.js";
import { registerInspectTools } from "../../../src/tools/inspect.js";
import { registerConsoleTools } from "../../../src/tools/console.js";
import { registerNetworkTools } from "../../../src/tools/network.js";
import { registerDomTools } from "../../../src/tools/dom.js";

export function buildToolMap(): Map<string, CapturedTool> {
  return captureTools((server: McpServer) => {
    registerSessionTools(server);
    registerNavTools(server);
    registerSourceTools(server);
    registerBreakpointTools(server);
    registerExecutionTools(server);
    registerInspectTools(server);
    registerConsoleTools(server);
    registerNetworkTools(server);
    registerDomTools(server);
  });
}

/** Convenience: invoke a tool and parse a JSON success envelope. */
export async function call<T = any>(
  tools: Map<string, CapturedTool>,
  name: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`No registered tool '${name}'`);
  const envelope = await tool.handler(input);
  if (envelope.isError) {
    const err = parseErrorEnvelope(envelope);
    throw new Error(
      `Tool '${name}' returned error envelope: ${err?.error ?? "(unparseable)"} — ${err?.message ?? envelope.content[0]?.text}`,
    );
  }
  return parseOkEnvelope<T>(envelope);
}

/** Convenience: invoke a tool, expect an error envelope, return it. */
export async function callExpectError(
  tools: Map<string, CapturedTool>,
  name: string,
  input: Record<string, unknown> = {},
): Promise<{ error: string; message: string }> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`No registered tool '${name}'`);
  const envelope = await tool.handler(input);
  const err = parseErrorEnvelope(envelope);
  if (!err) {
    throw new Error(
      `Expected error envelope from '${name}', got success: ${envelope.content[0]?.text}`,
    );
  }
  return err;
}

// Vitest's pool=forks model runs each spec file in a fresh worker process
// that does NOT inherit process.env from globalSetup. We rely on a file
// handoff: globalSetup writes .vitest-cache/e2e-config.json; specs read
// from it on first call. Keep the env-var path as a fallback for in-process
// consumers (debug scripts, the main process for one-shot eval runs).

interface E2eConfig {
  serverUrl: string;
  serverPort: number;
  chromePort: number;
  browserSource: string;
  browserBinary: string;
}

let cachedConfig: E2eConfig | null = null;

function loadConfig(): E2eConfig {
  if (cachedConfig) return cachedConfig;
  // Env-var fast path — useful when running specs from the main process.
  if (process.env.CDP_TEST_CHROME_PORT && process.env.CDP_TEST_SERVER_URL) {
    cachedConfig = {
      serverUrl: process.env.CDP_TEST_SERVER_URL,
      serverPort: Number(process.env.CDP_TEST_SERVER_PORT ?? 0),
      chromePort: Number(process.env.CDP_TEST_CHROME_PORT),
      browserSource: process.env.CDP_TEST_BROWSER_SOURCE ?? "unknown",
      browserBinary: process.env.CDP_TEST_BROWSER_BINARY ?? "unknown",
    };
    return cachedConfig;
  }
  // File handoff — the default when vitest runs specs in worker forks.
  const file = join(process.cwd(), ".vitest-cache", "e2e-config.json");
  try {
    cachedConfig = JSON.parse(readFileSync(file, "utf8")) as E2eConfig;
    return cachedConfig;
  } catch (e) {
    throw new Error(
      `e2e helpers: could not load ${file} (${(e as Error).message}). globalSetup did not run — check test/e2e/setup/global.ts.`,
    );
  }
}

/** Attach to the Chrome that globalSetup launched. Specs that need a fresh
 *  session call this at the top of each `it` (or in a beforeEach if every
 *  test in the file needs one). */
export async function attachToTestChrome(tools: Map<string, CapturedTool>): Promise<{
  targetId: string;
  url: string;
}> {
  const cfg = loadConfig();
  return await call(tools, "attach_chrome", { port: cfg.chromePort });
}

/** Sample-app URL published by globalSetup. */
export function sampleAppUrl(): string {
  return loadConfig().serverUrl;
}
