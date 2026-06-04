// L3 DOM: query_selector / click / type_text / press_key + a not_found
// negative case. The sample-app's index.html has a button (#go), a counter
// display (#out), and a text input (#name-input) wired to a label
// (#name-echo). The DOM tools' contract is small but every spec depends
// on it (the breakpoint/console/exception specs all use click) — so this
// spec validates the contract in isolation.

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildToolMap,
  call,
  callExpectError,
  attachToTestChrome,
  sampleAppUrl,
} from "./helpers/build-tools.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

describe("DOM (e2e)", () => {
  beforeEach(async () => setup());

  it("query_selector finds the button", async () => {
    const r = await call<{ found: boolean; tag: string; attrs: Record<string, string> }>(
      tools,
      "query_selector",
      { selector: "#go" },
    );
    expect(r.found).toBe(true);
    expect(r.tag).toBe("button");
    expect(r.attrs.id).toBe("go");
  });

  it("query_selector for a missing element returns found:false (NOT an error)", async () => {
    // The tool contract: not-found is a value, not an error envelope. The
    // error envelope is reserved for "no_session"-class failures.
    const r = await call<{ found: boolean }>(tools, "query_selector", {
      selector: "#does-not-exist",
    });
    expect(r.found).toBe(false);
  });

  it("get_element_html with neither selector nor node_id is missing_arg", async () => {
    const err = await callExpectError(tools, "get_element_html", {});
    expect(err.error).toBe("missing_arg");
  });

  it("click + type_text + press_key drive the input echo", async () => {
    await call(tools, "click", { selector: "#name-input" });
    await call(tools, "type_text", { selector: "#name-input", text: "Alice", clear_first: true });
    await call(tools, "press_key", { key: "Tab" });

    // The echo span updates synchronously on 'input', but Input.insertText
    // events are queued — poll for stable state instead of asserting
    // immediately.
    await waitFor(
      async () => {
        const r = await call<{ found: boolean; text_preview?: string }>(tools, "query_selector", {
          selector: "#name-echo",
        });
        if (!r.found) return null;
        const html = await call<{ html: string }>(tools, "get_element_html", {
          selector: "#name-echo",
        });
        return html.html.includes("Alice") ? html : null;
      },
      { describe: "#name-echo reflects typed value" },
    );
  });
});
