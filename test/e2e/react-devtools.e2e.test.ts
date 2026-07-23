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

  it("materializes and inspects exact development React fixture ground truth", async () => {
    const browser = await attachToTestChrome(tools, { label: "react-inspector" });
    await call(tools, "navigate", {
      session: browser.session,
      url: `${fixtureUrl}?rdt_fixture=1`,
      wait: "load",
    });
    await call<AttachResult>(tools, "attach_react_devtools", {
      session: browser.session,
      timeout_ms: 15_000,
    });

    const tree = await call<any>(tools, "get_react_tree", {
      session: browser.session,
      max_depth: 20,
      max_children: 200,
      max_nodes: 2_000,
    });
    const widget = await call<any>(tools, "find_react_component", {
      session: browser.session,
      name: "InspectorWidget",
      exact: true,
    });
    const provider = await call<any>(tools, "find_react_component", {
      session: browser.session,
      name: "InspectorContext.Provider",
      exact: true,
    });
    const stateBox = await call<any>(tools, "find_react_component", {
      session: browser.session,
      name: "InspectorStateBox",
      exact: true,
    });
    const rows = await call<any>(tools, "find_react_component", {
      session: browser.session,
      name: "FixtureRow",
      exact: true,
    });
    const widgetInspection = await call<any>(tools, "inspect_react_component", {
      session: browser.session,
      component_id: widget.matches[0].component_id,
      renderer_id: widget.matches[0].renderer_id,
    });
    const providerInspection = provider.matches[0]
      ? await call<any>(tools, "inspect_react_component", {
          session: browser.session,
          component_id: provider.matches[0].component_id,
          renderer_id: provider.matches[0].renderer_id,
        })
      : null;
    const stateInspection = await call<any>(tools, "inspect_react_component", {
      session: browser.session,
      component_id: stateBox.matches[0].component_id,
      renderer_id: stateBox.matches[0].renderer_id,
    });
    expect(tree).toMatchObject({
      generation: 1,
      total_nodes: 7,
      returned_nodes: 7,
      truncated: false,
      truncation_reasons: [],
      warnings: [],
      renderers: [
        {
          renderer_id: 1,
          bundle_type: 1,
          renderer_version: "18.3.1",
          renderer_package_name: "react-dom",
          supports_fiber: true,
        },
      ],
    });
    const root = tree.roots[0];
    const fixture = root.children[0];
    const contextProvider = fixture.children[0];
    expect(root).toMatchObject({
      display_name: null,
      type: "root",
      depth: 0,
      path: "root[1:1]",
    });
    expect(fixture).toMatchObject({
      display_name: "ReactInspectorFixture",
      type: "function",
      depth: 1,
    });
    expect(contextProvider).toMatchObject({
      display_name: "InspectorContext.Provider",
      type: "context",
      depth: 2,
    });
    expect(
      contextProvider.children.map((child: any) => ({
        name: child.display_name,
        type: child.type,
        key: child.key,
      })),
    ).toEqual([
      { name: "InspectorWidget", type: "function", key: null },
      { name: "InspectorStateBox", type: "class", key: null },
      { name: "FixtureRow", type: "function", key: "alpha" },
      { name: "FixtureRow", type: "function", key: "beta" },
    ]);

    expect(widget).toMatchObject({ total_matches: 1, returned_matches: 1 });
    expect(provider).toMatchObject({ total_matches: 1, returned_matches: 1 });
    expect(stateBox).toMatchObject({ total_matches: 1, returned_matches: 1 });
    expect(rows).toMatchObject({ total_matches: 2, returned_matches: 2 });
    expect(rows.matches.map((match: any) => match.key)).toEqual(["alpha", "beta"]);

    expect(widgetInspection.props).toEqual({
      data: { label: "runtime-widget" },
      cleaned_paths: [],
      unserializable_paths: [],
    });
    expect(widgetInspection.hooks.data.map((hook: any) => hook.name)).toEqual([
      "InspectorContext",
      "FixtureCounter",
      "Effect",
    ]);
    expect(widgetInspection.hooks.data[0].value).toEqual({
      theme: "midnight",
      fontScale: 1.25,
    });
    expect(
      widgetInspection.hooks.data[1].subHooks.map((hook: any) => ({
        name: hook.name,
        value: hook.name === "State" ? hook.value : undefined,
      })),
    ).toEqual([
      { name: "State", value: 2 },
      { name: "Effect", value: undefined },
    ]);
    expect(widgetInspection.source).toMatchObject({
      line: 39,
      column: 27,
      component_name: "InspectorWidget",
      generated: { session_id: null },
    });
    expect(widgetInspection.source.file).toMatch(
      /\/src\/ReactInspectorFixture\.tsx$/,
    );
    expect(widgetInspection.source_note).toBeNull();

    expect(stateInspection).toMatchObject({
      props: { data: { label: "runtime-state" } },
      state: { data: { status: "ready" } },
      context: {
        data: { value: { theme: "midnight", fontScale: 1.25 } },
      },
    });
    expect(providerInspection).toMatchObject({
      props: {
        data: { value: { theme: "midnight", fontScale: 1.25 } },
      },
      source: null,
    });
    expect(providerInspection.source_note).toContain("normal");

    await call(tools, "click", {
      session: browser.session,
      selector: "#rdt-add-row",
    });
    const updatedRows = await waitFor(
      async () => {
        const result = await call<any>(tools, "find_react_component", {
          session: browser.session,
          name: "FixtureRow",
          exact: true,
        });
        return result.total_matches === 3 ? result : null;
      },
      {
        timeoutMs: 10_000,
        describe: "third React fixture row after structural update",
      },
    );
    expect(updatedRows.matches.map((match: any) => match.key)).toEqual([
      "alpha",
      "beta",
      "row-3",
    ]);
    const updatedTree = await call<any>(tools, "get_react_tree", {
      session: browser.session,
      max_depth: 20,
      max_children: 200,
      max_nodes: 2_000,
    });
    expect(updatedTree).toMatchObject({
      generation: 1,
      total_nodes: 8,
      returned_nodes: 8,
      truncated: false,
    });
  });
});
