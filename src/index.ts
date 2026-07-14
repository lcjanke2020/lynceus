#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "./server.js";
import { getSession, sessionState } from "./session/state.js";
import { log } from "./util/log.js";
import { envWithFallback } from "./util/env.js";

interface StdioMode {
  transport: "stdio";
}

interface SseMode {
  transport: "sse";
  host: string;
  port: number;
  allowRemote: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

type ServerMode = StdioMode | SseMode;

export interface SseClient {
  server: McpServer;
  transport: SSEServerTransport;
}

export function parseArgs(args: string[]): ServerMode {
  let port: number | undefined;
  let host = "127.0.0.1";
  let allowRemote = envWithFallback("LYNCEUS_ALLOW_REMOTE", "CDP_MCP_ALLOW_REMOTE") === "1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        [
          "Usage:",
          "  lynceus                                  # stdio MCP transport",
          "  lynceus --port 9719                      # SSE MCP transport on 127.0.0.1:9719",
          "  lynceus --host 0.0.0.0 --port 9719 --allow-remote",
          "",
          "SSE mode caveats:",
          "  - Single-client only: concurrent /sse connections race on a",
          "    shared browser session (sessionState is process-global).",
          "  - Non-loopback bind requires --allow-remote (or",
          "    LYNCEUS_ALLOW_REMOTE=1). MCP tools include in-page eval and",
          "    server-filesystem writes; exposing them remotely without",
          "    further auth is a deliberate operator decision.",
          "  - Host / Origin headers are validated against the loopback",
          "    aliases (127.0.0.1, localhost, [::1]) to block",
          "    DNS-rebinding. On non-loopback binds the operator has",
          "    accepted exposure via --allow-remote, and we cannot",
          "    enumerate every reachable hostname/IP, so the checks",
          "    are skipped — front the server with a reverse proxy if",
          "    you need per-Host policy.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--port") {
      const value = args[index + 1];
      if (!value) throw new Error("--port requires a value");
      port = parsePort(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) throw new Error("--host requires a value");
      host = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--allow-remote") {
      allowRemote = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (port === undefined) {
    return { transport: "stdio" };
  }

  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing to bind SSE transport on non-loopback host '${host}' without --allow-remote (or LYNCEUS_ALLOW_REMOTE=1). MCP tools include in-page eval and server-filesystem writes; remote exposure is opt-in.`,
    );
  }

  return {
    transport: "sse",
    host,
    port,
    allowRemote,
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${raw}`);
  }
  return port;
}

const DEFAULT_SSE_KEEPALIVE_MS = 25_000;

// SSE streams sit idle between tool calls, and HTTP clients enforce a
// body-idle timeout (e.g. undici inside GitHub Copilot CLI tears the stream
// down after ~12 min with "Body Timeout Error"). A periodic SSE comment frame
// (`: ...\n\n`) is a no-op per the spec but resets that idle timer. Tunable via
// LYNCEUS_SSE_KEEPALIVE_MS (non-negative integer ms; 0 disables). See issue #1.
export function getKeepaliveMs(): number {
  // Trim so a whitespace-only value falls back to the default like other
  // unset/empty input — untrimmed, Number(" ") === 0 would silently hit the
  // "disable keepalive" sentinel (issue #3). Only an explicit 0 disables.
  const raw = envWithFallback("LYNCEUS_SSE_KEEPALIVE_MS", "CDP_MCP_SSE_KEEPALIVE_MS")?.trim();
  if (!raw) return DEFAULT_SSE_KEEPALIVE_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    log.warn("invalid SSE keepalive interval; using default", { value: raw, default: DEFAULT_SSE_KEEPALIVE_MS });
    return DEFAULT_SSE_KEEPALIVE_MS;
  }
  return value;
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));

  if (mode.transport === "sse") {
    await runSseServer(mode);
    return;
  }

  await runStdioServer();
}

async function runStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("lynceus server started", { pid: process.pid });

  const shutdown = async (signal: string) => {
    log.info(`shutdown signal: ${signal}`);
    try {
      const session = getSession();
      if (session) await sessionState.close();
    } catch (e) {
      log.warn("error during shutdown", { error: String(e) });
    }
    try {
      await server.close();
    } catch (e) {
      log.warn("error closing server", { error: String(e) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  installProcessErrorHandlers();
}

export interface SseGateConfig {
  validateHostOrigin: boolean;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

// Host/Origin validation is a DNS-rebinding defense — it bites only
// on loopback binds, where an attacker page can be tricked into
// reaching 127.0.0.1 via a rebound DNS name. On non-loopback binds
// the operator has explicitly accepted exposure via --allow-remote,
// and we cannot statically enumerate every hostname/IP the host
// might be reached by (LAN IP, hostname, mDNS, VPN, …) — so we skip
// both checks and treat --allow-remote as the gate.
export function buildSseGateConfig(host: string, port: number): SseGateConfig {
  const validateHostOrigin = isLoopbackHost(host);
  return {
    validateHostOrigin,
    allowedHosts: validateHostOrigin ? buildAllowedHosts(host, port) : new Set<string>(),
    allowedOrigins: validateHostOrigin ? buildAllowedOrigins(host, port) : new Set<string>(),
  };
}

async function runSseServer(mode: SseMode): Promise<void> {
  const clients = new Map<string, SseClient>();
  const { validateHostOrigin, allowedHosts, allowedOrigins } = buildSseGateConfig(mode.host, mode.port);
  const httpServer = createServer((req, res) => {
    void handleSseRequest({
      req,
      res,
      clients,
      host: mode.host,
      port: mode.port,
      validateHostOrigin,
      allowedHosts,
      allowedOrigins,
    });
  });

  await listen(httpServer, mode);
  log.info("lynceus SSE server started", {
    pid: process.pid,
    url: `http://${mode.host}:${mode.port}/sse`,
    allowRemote: mode.allowRemote,
  });
  if (!isLoopbackHost(mode.host)) {
    log.warn(
      "SSE bound to non-loopback host — exposing in-page eval + filesystem-write tools without auth (operator opted in via --allow-remote)",
      { host: mode.host, port: mode.port },
    );
  }

  // Close SSE transports BEFORE the HTTP server: Node's server.close()
  // waits for in-flight requests to drain, and /sse connections are
  // long-lived by design — closing the HTTP server first would hang
  // SIGINT / SIGTERM indefinitely.
  const shutdown = async (signal: string) => {
    log.info(`shutdown signal: ${signal}`);
    await closeSseClients(clients);
    await closeHttpServer(httpServer);
    try {
      const session = getSession();
      if (session) await sessionState.close();
    } catch (e) {
      log.warn("error during shutdown", { error: String(e) });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  installProcessErrorHandlers();
}

function installProcessErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { error: String(err), stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", { reason: String(reason) });
  });
}

export async function handleSseRequest({
  req,
  res,
  clients,
  host,
  port,
  validateHostOrigin,
  allowedHosts,
  allowedOrigins,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  clients: Map<string, SseClient>;
  host: string;
  port: number;
  validateHostOrigin: boolean;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}): Promise<void> {
  try {
    // DNS-rebinding defense for loopback binds: validate Host (and
    // Origin if present) before the SDK touches the request. The MCP
    // SDK's SSEServerTransport does not gate either header by default.
    // Skipped on non-loopback binds — see runSseServer for rationale.
    if (validateHostOrigin) {
      const headerHost = req.headers.host;
      if (!headerHost || !allowedHosts.has(headerHost)) {
        log.warn("rejecting SSE request with disallowed Host header", {
          host: headerHost,
          bindHost: host,
        });
        respondText(res, 403, "forbidden\n");
        return;
      }
      // Origin is only sent by browsers (and is `null` for sandboxed
      // iframes / file://). Checking it when present is the
      // cross-origin defense layer; the Host check above is what
      // catches non-browser callers and Origin-omitting browsers.
      const originHeader = req.headers.origin;
      if (originHeader && !allowedOrigins.has(originHeader)) {
        log.warn("rejecting SSE request with disallowed Origin header", { origin: originHeader });
        respondText(res, 403, "forbidden\n");
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      await startSseConnection({ res, clients });
      return;
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      await handleSseMessage({ req, res, clients, sessionId: url.searchParams.get("sessionId") });
      return;
    }

    respondText(res, 404, "not found\n");
  } catch (e) {
    log.error("SSE request failed", { error: String(e) });
    if (!res.headersSent) {
      respondText(res, 500, "internal server error\n");
    } else {
      res.end();
    }
  }
}

// Called only on loopback binds (see runSseServer). The set covers the
// three loopback aliases a browser or CLI might use to reach a 127.0.0.1
// / localhost / ::1 server; anything else implies DNS-rebinding.
function buildAllowedHosts(bindHost: string, port: number): Set<string> {
  const hosts = new Set<string>([
    `${bindHost}:${port}`,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return hosts;
}

function buildAllowedOrigins(bindHost: string, port: number): Set<string> {
  const origins = new Set<string>();
  for (const hostPort of buildAllowedHosts(bindHost, port)) {
    origins.add(`http://${hostPort}`);
    origins.add(`https://${hostPort}`);
  }
  return origins;
}

async function startSseConnection({
  res,
  clients,
}: {
  res: ServerResponse;
  clients: Map<string, SseClient>;
}): Promise<void> {
  const transport = new SSEServerTransport("/messages", res);
  const server = buildServer();

  // Assigned after connect() (below) so the keepalive never writes before the
  // SDK has sent the SSE response headers; cleared here on disconnect. The
  // `closed` flag makes a post-close arm a no-op: unreachable with the current
  // SDK (connect() resolves without yielding to IO after registering the close
  // listener), but an upstream change there would otherwise leak the timer
  // (issue #3).
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  transport.onclose = () => {
    closed = true;
    if (keepalive) clearInterval(keepalive);
    const client = clients.get(transport.sessionId);
    clients.delete(transport.sessionId);
    void client?.server.close().catch((e) => {
      log.warn("error closing MCP server for SSE client", { sessionId: transport.sessionId, error: String(e) });
    });
  };
  transport.onerror = (e) => {
    log.warn("SSE transport error", { sessionId: transport.sessionId, error: String(e) });
  };

  clients.set(transport.sessionId, { server, transport });
  await server.connect(transport);

  // connect() has now written the SSE headers + endpoint event, so it's safe
  // to interleave keepalive comment frames on the stream.
  const keepaliveMs = getKeepaliveMs();
  if (keepaliveMs > 0 && !closed) {
    keepalive = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(": keepalive\n\n");
      } catch (e) {
        log.warn("SSE keepalive write failed", { sessionId: transport.sessionId, error: String(e) });
      }
    }, keepaliveMs);
    // Don't let the keepalive timer alone keep the process alive.
    keepalive.unref();
  }

  log.info("SSE client connected", { sessionId: transport.sessionId });
}

async function handleSseMessage({
  req,
  res,
  clients,
  sessionId,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  clients: Map<string, SseClient>;
  sessionId: string | null;
}): Promise<void> {
  if (!sessionId) {
    respondText(res, 400, "missing sessionId\n");
    return;
  }

  const client = clients.get(sessionId);
  if (!client) {
    respondText(res, 404, "unknown sessionId\n");
    return;
  }

  await client.transport.handlePostMessage(req, res);
}

async function listen(server: HttpServer, mode: SseMode): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(mode.port, mode.host);
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((e) => {
      if (e) {
        reject(e);
        return;
      }
      resolve();
    });
  }).catch((e: unknown) => {
    log.warn("error closing HTTP server", { error: String(e) });
  });
}

async function closeSseClients(clients: Map<string, SseClient>): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();

  await Promise.all(
    entries.map(async ([sessionId, client]) => {
      try {
        await client.transport.close();
      } catch (e) {
        log.warn("error closing SSE transport", { sessionId, error: String(e) });
      }
      try {
        await client.server.close();
      } catch (e) {
        log.warn("error closing MCP server", { sessionId, error: String(e) });
      }
    }),
  );
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

// Only run the server when executed as the CLI entry point — not when this
// module is imported (e.g. by the SSE transport tests). `realpathSync`
// resolves the npm bin symlink so the comparison holds for global installs.
// The cdp-mcp compat shim (wrapper/cdp-mcp/bin.js) boots the server by
// pointing argv[1] at this module before importing it — keep in sync.
function isRunAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  main().catch((err) => {
    log.error("fatal", { error: String(err), stack: err?.stack });
    process.exit(1);
  });
}
