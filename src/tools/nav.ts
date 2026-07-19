import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Protocol } from "devtools-protocol";
import { requireSession, requireCapable } from "../session/state.js";
import { registerJsonTool } from "./_register.js";

type WaitMode = "load" | "domcontentloaded" | "networkidle" | "none";

export function registerNavTools(server: McpServer) {
  registerJsonTool(
    server,
    "navigate",
    "Navigate the active page to a URL. Waits for the chosen load milestone.",
    {
      url: z.string(),
      wait: z.enum(["load", "domcontentloaded", "networkidle", "none"]).optional()
        .describe("Default: load"),
      timeout_ms: z.number().int().positive().optional(),
    },
    async (input: { url: string; wait?: WaitMode; timeout_ms?: number }) => {
      const s = requireSession();
      requireCapable(s, "navigate");
      const wait = input.wait ?? "load";
      const timeout = input.timeout_ms ?? 30000;
      const loadPromise = waitForLoad(s.client!, wait, timeout);
      await s.client!.send("Page.navigate", { url: input.url });
      await loadPromise;
      const { frameTree } = await s.client!.send("Page.getFrameTree");
      s.url = frameTree.frame.url || null; // keep list_sessions' url current across navigations (null, never "")
      return { url: frameTree.frame.url, wait };
    },
  );

  registerJsonTool(
    server,
    "reload",
    "Reload the active page.",
    { hard: z.boolean().optional().describe("Bypass cache") },
    async (input: { hard?: boolean }) => {
      const s = requireSession();
      requireCapable(s, "reload");
      await s.client!.send("Page.reload", { ignoreCache: !!input.hard });
      return "reloaded";
    },
  );

  registerJsonTool(
    server,
    "get_url",
    "Return the current top-frame URL.",
    undefined,
    async () => {
      const s = requireSession();
      requireCapable(s, "get_url");
      const { frameTree } = await s.client!.send("Page.getFrameTree");
      return { url: frameTree.frame.url };
    },
  );
}

function waitForLoad(
  client: import("chrome-remote-interface").Client,
  mode: WaitMode,
  timeoutMs: number,
): Promise<void> {
  if (mode === "none") return Promise.resolve();
  // Gate to the root session: top-level navigation completion is only
  // meaningful for the top frame. Now that the multi-target fix wires
  // Page.enable + Network.enable for every child session (OOPIFs, workers,
  // service workers), their events stream through the same root client
  // tagged with their own eventSessionId. Without this gate, a cross-origin
  // iframe firing Page.loadEventFired would prematurely settle navigate(),
  // and an analytics iframe polling /beacon would starve `networkidle`
  // forever.
  const isRoot = (esid: string | undefined) => esid === undefined;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    type Listener = { event: string; fn: (...args: any[]) => void };
    const listeners: Listener[] = [];
    const off = (api: typeof client) => {
      for (const { event, fn } of listeners) {
        (api as unknown as { removeListener: (e: string, h: Function) => void }).removeListener(event, fn);
      }
      listeners.length = 0;
    };
    const reg = (event: string, fn: (...args: any[]) => void) => {
      client.on(event as any, fn as any);
      listeners.push({ event, fn });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off(client);
      reject(new Error(`navigate: ${mode} not reached within ${timeoutMs}ms`));
    }, timeoutMs);

    let idleTimer: NodeJS.Timeout | null = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      off(client);
      resolve();
    };

    if (mode === "load") {
      reg("Page.loadEventFired", (_p: unknown, esid?: string) => {
        if (isRoot(esid)) done();
      });
    } else if (mode === "domcontentloaded") {
      reg("Page.domContentEventFired", (_p: unknown, esid?: string) => {
        if (isRoot(esid)) done();
      });
    } else if (mode === "networkidle") {
      // Track in-flight root-session requests. The previous version reset
      // the 500ms idle timer on both requestWillBeSent and loadingFinished
      // — which meant a slow request that took 600ms to finish would emit
      // the start event, then 500ms later `done()` fired while the
      // request was still loading. networkidle resolved while a request
      // was in flight.
      //
      // Correct semantics: idle timer starts ONLY when the in-flight set
      // is empty, and resets whenever a new request joins.
      const inFlight = new Set<string>();
      const armIdleIfEmpty = () => {
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        if (inFlight.size === 0) idleTimer = setTimeout(done, 500);
      };
      reg("Network.requestWillBeSent", (p: Protocol.Network.RequestWillBeSentEvent, esid?: string) => {
        if (settled || !isRoot(esid)) return;
        // Skip persistent-connection types: WebSocket and EventSource stay
        // open until the page navigates away, so they never emit
        // Network.loadingFinished — tracking them would hold networkidle
        // forever. Every Vite/Next/Astro dev server opens an HMR WebSocket,
        // so this was the universal failure mode.
        if (p.type === "WebSocket" || p.type === "EventSource") return;
        inFlight.add(p.requestId);
        if (idleTimer) clearTimeout(idleTimer);
      });
      reg("Network.loadingFinished", (p: Protocol.Network.LoadingFinishedEvent, esid?: string) => {
        if (settled || !isRoot(esid)) return;
        inFlight.delete(p.requestId);
        armIdleIfEmpty();
      });
      reg("Network.loadingFailed", (p: Protocol.Network.LoadingFailedEvent, esid?: string) => {
        if (settled || !isRoot(esid)) return;
        inFlight.delete(p.requestId);
        armIdleIfEmpty();
      });
      // Initial arm — if nothing fires, we're already idle.
      armIdleIfEmpty();
    }
  });
}

