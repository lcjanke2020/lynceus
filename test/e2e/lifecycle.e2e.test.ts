// L3 lifecycle: attach to the headless Chrome that globalSetup launched,
// navigate to the sample-app, enumerate targets, switch targets, close.
// First spec the e2e runner trips on if anything in globalSetup is broken
// — keep it minimal and fail fast.

import { describe, it, expect } from "vitest";
import { buildToolMap, call, attachToTestChrome, sampleAppUrl } from "./helpers/build-tools.js";

const tools = buildToolMap();

describe("lifecycle (e2e)", () => {
  it("attach + navigate + list_targets + get_url round-trip", async () => {
    const attach = await attachToTestChrome(tools);
    expect(attach.targetId).toMatch(/^[A-F0-9]{16,}$/i);

    const nav = await call<{ url: string; wait: string }>(tools, "navigate", {
      url: sampleAppUrl(),
      wait: "load",
    });
    // After navigate the URL must reflect the sample-app, not about:blank.
    expect(nav.url).toContain("127.0.0.1");

    const urlResp = await call<{ url: string }>(tools, "get_url");
    expect(urlResp.url).toContain("127.0.0.1");

    const targets = await call<Array<{ id: string; type: string; url: string; active: boolean }>>(
      tools,
      "list_targets",
    );
    const page = targets.find((t) => t.type === "page" && t.active);
    expect(page, `expected an active page target; got ${JSON.stringify(targets)}`).toBeTruthy();
  });

  it("close_session leaves Chrome alive (attached mode); subsequent attach works", async () => {
    await attachToTestChrome(tools);
    const r1 = await call<string>(tools, "close_session");
    expect(r1).toBe("closed");
    // Re-attaching to the same Chrome must succeed — globalSetup-launched
    // chrome is shared across specs.
    const reattach = await attachToTestChrome(tools);
    expect(reattach.targetId).toBeTruthy();
  });
});
