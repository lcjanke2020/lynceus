// L3 network: verify the network buffer captures real page-load traffic
// and get_response_body can fetch the document body. The static server is
// 127.0.0.1:<random>; the sample-app fetches its own bundle + worker +
// (potentially) the source maps.

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

describe("network (e2e)", () => {
  beforeEach(async () => setup());

  it("get_network_requests includes the document fetch", async () => {
    const items = await waitFor(
      async () => {
        const r = await call<{
          items: Array<{ url: string; type: string; status?: number; request_id: string; finished: boolean }>;
        }>(tools, "get_network_requests");
        const docs = r.items.filter((e) => e.type === "Document" && e.finished);
        return docs.length > 0 ? docs : null;
      },
      { describe: "Document request finished" },
    );
    const doc = items[0]!;
    expect(doc.url).toContain("127.0.0.1");
    expect(doc.status).toBe(200);
  });

  it("get_response_body decodes the HTML body for the document request", async () => {
    const doc = await waitFor(
      async () => {
        const r = await call<{
          items: Array<{ url: string; type: string; finished: boolean; request_id: string; session_id: string | null }>;
        }>(tools, "get_network_requests");
        return r.items.find((e) => e.type === "Document" && e.finished) ?? null;
      },
      { describe: "Document request finished" },
    );
    const body = await call<{
      base64_encoded: boolean;
      body: string;
    }>(tools, "get_response_body", {
      request_id: doc.request_id,
      session_id: doc.session_id,
    });
    // The tool layer currently returns text/* responses un-base64'd. Tolerate
    // a future change that always-base64's (Opus PR #11 review M5): branch on
    // the flag, decode if needed, then assert the body contains the HTML
    // marker.
    const decoded = body.base64_encoded
      ? Buffer.from(body.body, "base64").toString("utf8")
      : body.body;
    // Asserts a stable, neutral marker — the page's <h1>/title text was
    // neutralized to avoid leaking bug symptoms into the L4 eval surface
    // (PR #15 review). The button is functional and not going anywhere.
    expect(decoded).toContain('id="go"');
  });
});
