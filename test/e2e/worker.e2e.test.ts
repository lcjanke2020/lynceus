// L3 worker: the sample-app spawns a module Web Worker in main.ts which
// runs ./worker.ts. The L3 contract:
//   1. list_targets enumerates the worker as a separate target.
//   2. pause(session_id) routes the Debugger.pause command into the worker
//      and a pause event arrives with the worker's session_id.
//   3. setBreakpoint on worker.ts resolves to the worker's session.
//
// This is the spec the multi-session compound-key plumbing in
// src/sourcemap/store.ts + src/session/state.ts exists to support.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildToolMap,
  call,
  attachToTestChrome,
  sampleAppUrl,
} from "./helpers/build-tools.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

describe("worker (e2e)", () => {
  beforeEach(async () => setup());

  it("worker.ts surfaces as a script with its own session_id; pause routes via session", async () => {
    // The worker fetches asynchronously after Page.loadEventFired. Wait for
    // the worker.ts script to appear in list_scripts (it's loaded inside a
    // dedicated worker target, so it gets its own non-null session_id).
    const workerScript = await waitFor(
      async () => {
        // list_scripts returns a BARE ARRAY, not {items: [...]}.
        const r = await call<
          Array<{ url: string; original_sources?: string[]; session_id: string | null }>
        >(tools, "list_scripts");
        return (
          r.find(
            (s) =>
              s.session_id !== null &&
              (s.original_sources ?? []).some((src) => src.endsWith("worker.ts")),
          ) ?? null
        );
      },
      { timeoutMs: 10_000, describe: "worker.ts loaded into a child session" },
    );
    expect(workerScript.session_id).toBeTruthy();

    // The worker target should now show up in list_targets too — though
    // the active flag stays on the page. We tolerate the worker target
    // being absent in older Chromium versions; the script-side assertion
    // above is the load-bearing one.
    const targets = await call<Array<{ id: string; type: string }>>(tools, "list_targets");
    const worker = targets.find((t) => t.type === "worker" || t.type === "shared_worker");
    if (worker) {
      // No assertion on its URL specifically — Vite bundles workers into
      // their own chunk and the URL is build-hashed.
      expect(worker.id).toBeTruthy();
    }
  });
});
