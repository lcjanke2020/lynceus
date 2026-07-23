// L3 bridge smoke for LEO-359 PR 1b. This deliberately runs the React
// fixture through Vite's development server: a production bundle changes
// React DevTools metadata and would not exercise the supported dev-build
// path. The server binds port 0 so this spec composes with local/CI services.

import { createRequire } from "node:module";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireSession } from "../../src/session/state.js";
import {
  attachToTestChrome,
  buildToolMap,
  call,
} from "./helpers/build-tools.js";
import { waitFor } from "./helpers/wait-for.js";

interface FixtureViteServer {
  readonly middlewares: (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => void;
  close(): Promise<void>;
}

interface ViteModule {
  createServer(config: Record<string, unknown>): Promise<FixtureViteServer>;
}

interface AttachResult {
  framework: "react";
  status: "attached" | "already-attached";
  generation: number;
  backend_version: string;
  events_buffered: number;
}

const tools = buildToolMap();
const fixtureRoot = join(
  process.cwd(),
  "examples",
  "sample-fullstack-app",
);
let viteServer: FixtureViteServer | null = null;
let httpServer: HttpServer | null = null;
let fixtureUrl = "";

beforeAll(async () => {
  // Resolve from the fixture so Vite remains a fixture-local dependency and
  // does not enlarge lynceus's production dependency surface.
  const fixtureRequire = createRequire(join(fixtureRoot, "package.json"));
  const vitePackageRoot = dirname(fixtureRequire.resolve("vite/package.json"));
  const viteEntry = join(vitePackageRoot, "dist", "node", "index.js");
  const vite = (await import(pathToFileURL(viteEntry).href)) as ViteModule;

  // Vite treats server.port=0 as its default fixed port. Run it as Connect
  // middleware behind our own HTTP server instead so Node performs a true
  // ephemeral-port bind. Supplying that server to HMR retains the fixture's
  // normal React Refresh bootstrap (including its late-attach hook shim).
  httpServer = createHttpServer((request, response) => {
    if (!viteServer) {
      response.statusCode = 503;
      response.end("Vite is starting");
      return;
    }
    viteServer.middlewares(request, response, () => {
      response.statusCode = 404;
      response.end("Not found");
    });
  });
  viteServer = await vite.createServer({
    root: fixtureRoot,
    logLevel: "error",
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
    },
  });
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("React fixture Vite server did not expose a TCP address");
  }
  fixtureUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await viteServer?.close();
  viteServer = null;
  if (httpServer?.listening) {
    await new Promise<void>((resolve, reject) => {
      httpServer!.close((error) => (error ? reject(error) : resolve()));
    });
  }
  httpServer = null;
});

describe("React DevTools bridge (e2e)", () => {
  it("attaches, observes operations across reload, detaches, and reattaches", async () => {
    const browser = await attachToTestChrome(tools, { label: "react-frontend" });
    await call(tools, "navigate", {
      session: browser.session,
      url: fixtureUrl,
      wait: "load",
    });

    const first = await call<AttachResult>(tools, "attach_react_devtools", {
      session: browser.session,
      timeout_ms: 15_000,
    });
    expect(first).toMatchObject({
      framework: "react",
      status: "attached",
      backend_version: "7.0.1",
    });
    expect(first.events_buffered).toBeGreaterThan(0);

    const initialDocumentGeneration =
      requireSession(browser.session).reactBridge!.documentGeneration;
    await call(tools, "reload", { session: browser.session });
    await waitFor(
      () => {
        const state = requireSession(browser.session);
        const bridge = state.reactBridge;
        return bridge &&
          bridge.documentGeneration > initialDocumentGeneration &&
          bridge.sentinelSeen &&
          bridge.operationsSeen &&
          state.reactEvents.size() > 0
          ? bridge.documentGeneration
          : null;
      },
      {
        timeoutMs: 15_000,
        describe: "fresh React backend operations after Page.reload",
      },
    );

    const detached = await call<{
      status: string;
      generation: number;
    }>(tools, "detach_react_devtools", { session: browser.session });
    expect(detached.status).toBe("detached");
    expect(requireSession(browser.session).reactBridge).toBeNull();

    const second = await call<AttachResult>(tools, "attach_react_devtools", {
      session: browser.session,
      timeout_ms: 15_000,
    });
    expect(second.status).toBe("attached");
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.events_buffered).toBeGreaterThan(0);
  });
});
