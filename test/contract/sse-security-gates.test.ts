// LEO-427: HTTP-layer tests for the SSE DNS-rebinding gates in
// handleSseRequest. README ("SSE caveats") and SECURITY.md advertise that
// loopback binds validate Host and Origin and 403 anything else before the
// MCP SDK sees the request — until now the only test of this file disabled
// validation. These drive the real handler over a real node:http server,
// wired through buildSseGateConfig exactly as runSseServer wires production.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { handleSseRequest, buildSseGateConfig, type SseClient, type SseGateConfig } from "../../src/index.js";
import { sessionState } from "../../src/session/state.js";

let httpServer: Server | undefined;
const clients = new Map<string, SseClient>();

afterEach(async () => {
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
});

// Boots a loopback HTTP server wired like runSseServer, except the gate
// config is computed AFTER listen so a port-0 bind resolves to the real
// port before the allowlists are built. `gateHost` is the hypothetical
// bind host the gate decision is derived from — the socket itself always
// binds 127.0.0.1 so the suite never opens a non-loopback listener.
async function startGatedServer(gateHost: string): Promise<{ port: number; gate: SseGateConfig }> {
  let gate: SseGateConfig | undefined;
  let port = 0;
  httpServer = createServer((req, res) => {
    void handleSseRequest({
      req,
      res,
      clients,
      host: "127.0.0.1",
      port,
      validateHostOrigin: gate!.validateHostOrigin,
      allowedHosts: gate!.allowedHosts,
      allowedOrigins: gate!.allowedOrigins,
    });
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
  port = (httpServer!.address() as AddressInfo).port;
  gate = buildSseGateConfig(gateHost, port);
  return { port, gate };
}

// Issues one request and resolves with status + body. Rejected requests end
// their body normally; an accepted /sse request is a live stream, so we
// resolve as soon as the SDK's endpoint event frame arrives and tear the
// connection down.
function probe({
  port,
  path,
  method = "GET",
  headers = {},
}: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.includes("event: endpoint")) {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, body });
        }
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("SSE security gates (LEO-427)", () => {
  it("rejects a disallowed Host header with 403 before the SDK sees the request", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    const res = await probe({ port, path: "/sse", headers: { host: `evil.example:${port}` } });
    expect(res.status).toBe(403);
    expect(res.body).toBe("forbidden\n");
    // No transport was registered — the SDK never saw the request.
    expect(clients.size).toBe(0);
  });

  it("rejects a rebound Host with no port", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    const res = await probe({ port, path: "/sse", headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(clients.size).toBe(0);
  });

  it("rejects a disallowed Origin with 403", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    const res = await probe({
      port,
      path: "/sse",
      headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toBe("forbidden\n");
    expect(clients.size).toBe(0);
  });

  it("rejects the literal 'null' Origin (sandboxed iframe / file://) conservatively", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    const res = await probe({
      port,
      path: "/sse",
      headers: { host: `127.0.0.1:${port}`, origin: "null" },
    });
    expect(res.status).toBe(403);
    expect(clients.size).toBe(0);
  });

  it("applies the Host gate to /messages POSTs before routing", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    const res = await probe({
      port,
      path: "/messages?sessionId=whatever",
      method: "POST",
      headers: { host: `evil.example:${port}` },
    });
    // 403 from the gate — not the 404 "unknown sessionId" the router would give.
    expect(res.status).toBe(403);
  });

  it("accepts all three canonical loopback Host aliases with no Origin", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await probe({ port, path: "/sse", headers: { host } });
      expect(res.status, `Host: ${host}`).toBe(200);
      expect(res.body, `Host: ${host}`).toContain("event: endpoint");
    }
  });

  it("accepts allowed Origins in both http and https forms", async () => {
    const { port } = await startGatedServer("127.0.0.1");
    for (const origin of [`http://localhost:${port}`, `https://127.0.0.1:${port}`]) {
      const res = await probe({
        port,
        path: "/sse",
        headers: { host: `127.0.0.1:${port}`, origin },
      });
      expect(res.status, `Origin: ${origin}`).toBe(200);
      expect(res.body, `Origin: ${origin}`).toContain("event: endpoint");
    }
  });

  it("skips Host/Origin validation on non-loopback binds (documented --allow-remote posture)", async () => {
    const { port, gate } = await startGatedServer("0.0.0.0");
    expect(gate.validateHostOrigin).toBe(false);
    const res = await probe({
      port,
      path: "/sse",
      headers: { host: "evil.example:1234", origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("event: endpoint");
  });
});
