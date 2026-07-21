import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startDevServer, type RunningDevServer } from "./dev-server.js";

const running: RunningDevServer[] = [];
const occupied: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    occupied.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("startDevServer", () => {
  it("waits for HTTP readiness and closes the managed child", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const program = [
      'const http = require("node:http");',
      `const server = http.createServer((_req, res) => res.end("ready"));`,
      `server.listen(${port}, "127.0.0.1");`,
      `process.on("SIGTERM", () => server.close(() => process.exit(0)));`,
    ].join("");

    const server = await startDevServer({
      cwd: process.cwd(),
      url,
      command: process.execPath,
      args: ["-e", program],
      startupTimeoutMs: 5_000,
    });
    running.push(server);

    expect(await (await fetch(url)).text()).toBe("ready");
    await server.close();
    running.pop();
    await expect(
      fetch(url, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });

  it("reports early child exit with captured diagnostics", async () => {
    const port = await freePort();
    await expect(
      startDevServer({
        cwd: process.cwd(),
        url: `http://127.0.0.1:${port}`,
        command: process.execPath,
        args: ["-e", 'process.stderr.write("fixture exploded"); process.exit(7)'],
        startupTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/code=7[\s\S]*fixture exploded/);
  });

  it("refuses an address already owned by another process, even on a non-2xx response", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end("occupied");
    });
    occupied.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    await expect(
      startDevServer({
        cwd: process.cwd(),
        url: `http://127.0.0.1:${port}`,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      }),
    ).rejects.toThrow(/already responding/);
  });
});
