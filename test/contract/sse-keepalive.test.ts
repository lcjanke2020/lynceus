// Issue #1, Bug 2: idle SSE streams were torn down by the HTTP client's
// body-idle timeout (undici inside Copilot CLI, ~12 min) because lynceus sent
// no keepalive. startSseConnection() now writes periodic `: keepalive\n\n`
// SSE comment frames, tunable via LYNCEUS_SSE_KEEPALIVE_MS (the deprecated
// CDP_MCP_SSE_KEEPALIVE_MS still works via the env fallback).
//
// This drives the real handleSseRequest wiring over a loopback HTTP server
// (validateHostOrigin disabled, mirroring a --allow-remote bind) with the
// interval cranked down to 50ms, and asserts a keepalive frame arrives.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { handleSseRequest, type SseClient } from "../../src/index.js";
import { sessionState } from "../../src/session/state.js";

let httpServer: Server | undefined;
let clientReq: ClientRequest | undefined;
const clients = new Map<string, SseClient>();

afterEach(async () => {
  clientReq?.destroy();
  clientReq = undefined;
  // Close the long-lived SSE transports before the HTTP server, else
  // server.close() blocks waiting for them to drain.
  for (const [, c] of clients) {
    try {
      await c.transport.close();
    } catch {
      /* best effort */
    }
    try {
      await c.server.close();
    } catch {
      /* best effort */
    }
  }
  clients.clear();
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = undefined;
  }
  sessionState.reset();
  delete process.env.CDP_MCP_SSE_KEEPALIVE_MS;
  delete process.env.LYNCEUS_SSE_KEEPALIVE_MS;
});

describe("SSE keepalive (issue #1)", () => {
  it("writes periodic ': keepalive' comment frames on an idle stream", async () => {
    process.env.CDP_MCP_SSE_KEEPALIVE_MS = "50";

    httpServer = createServer((req, res) => {
      void handleSseRequest({
        req,
        res,
        clients,
        host: "127.0.0.1",
        port: 0,
        validateHostOrigin: false,
        allowedHosts: new Set(),
        allowedOrigins: new Set(),
      });
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer!.address() as AddressInfo).port;

    let buffer = "";
    const sawKeepalive = new Promise<void>((resolve, reject) => {
      clientReq = request({ host: "127.0.0.1", port, path: "/sse", method: "GET" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.includes(": keepalive")) resolve();
        });
        res.on("error", reject);
      });
      clientReq.on("error", reject);
      clientReq.end();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no keepalive frame within 2s")), 2000);
    });
    try {
      await Promise.race([sawKeepalive, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    expect(buffer).toContain(": keepalive");
  });

  it("disables keepalive when CDP_MCP_SSE_KEEPALIVE_MS=0", async () => {
    process.env.CDP_MCP_SSE_KEEPALIVE_MS = "0";

    httpServer = createServer((req, res) => {
      void handleSseRequest({
        req,
        res,
        clients,
        host: "127.0.0.1",
        port: 0,
        validateHostOrigin: false,
        allowedHosts: new Set(),
        allowedOrigins: new Set(),
      });
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer!.address() as AddressInfo).port;

    let buffer = "";
    await new Promise<void>((resolve, reject) => {
      clientReq = request({ host: "127.0.0.1", port, path: "/sse", method: "GET" }, (res) => {
        res.setEncoding("utf8");
        // The endpoint event arrives immediately; give the (disabled) keepalive
        // several intervals' worth of wall-clock to prove it never fires.
        res.on("data", (chunk: string) => {
          buffer += chunk;
        });
        res.on("error", reject);
        setTimeout(resolve, 300);
      });
      clientReq.on("error", reject);
      clientReq.end();
    });

    expect(buffer).toContain("event: endpoint");
    expect(buffer).not.toContain(": keepalive");
  });

  it("honors the new LYNCEUS_SSE_KEEPALIVE_MS name", async () => {
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = "50";

    httpServer = createServer((req, res) => {
      void handleSseRequest({
        req,
        res,
        clients,
        host: "127.0.0.1",
        port: 0,
        validateHostOrigin: false,
        allowedHosts: new Set(),
        allowedOrigins: new Set(),
      });
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer!.address() as AddressInfo).port;

    let buffer = "";
    const sawKeepalive = new Promise<void>((resolve, reject) => {
      clientReq = request({ host: "127.0.0.1", port, path: "/sse", method: "GET" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.includes(": keepalive")) resolve();
        });
        res.on("error", reject);
      });
      clientReq.on("error", reject);
      clientReq.end();
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no keepalive frame within 2s")), 2000);
    });
    try {
      await Promise.race([sawKeepalive, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    expect(buffer).toContain(": keepalive");
  });
});
