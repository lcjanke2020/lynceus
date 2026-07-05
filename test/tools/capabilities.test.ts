// Matrix test for the per-tool capability table. Each browser-only tool must
// return the structured `unsupported_target` error envelope when invoked
// against a session with kind: "node", AND the gate must fire BEFORE any CDP
// call (otherwise a raw "Domain not enabled" error would surface instead of the
// agent-readable capability message).
//
// `select_target` is covered in test/tools/session.test.ts (which has its own
// vi.mock setup for chrome-remote-interface); the entries here cover the rest
// of the browser-only surface (nav / DOM / network / forms / storage).

import { describe, it, expect } from "vitest";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, type CapturedTool } from "../handler-registry.js";
import { registerNavTools } from "../../src/tools/nav.js";
import { registerDomTools } from "../../src/tools/dom.js";
import { registerNetworkTools } from "../../src/tools/network.js";
import { registerFormTools } from "../../src/tools/forms.js";
import { registerStorageTools } from "../../src/tools/storage.js";

autoReset();

const navTools = captureTools(registerNavTools);
const domTools = captureTools(registerDomTools);
const networkTools = captureTools(registerNetworkTools);
const formTools = captureTools(registerFormTools);
const storageTools = captureTools(registerStorageTools);

type Case = {
  tool: string;
  handler: CapturedTool;
  args: Record<string, unknown>;
};

const cases: Case[] = [
  // nav.ts — pass wait:"none" on navigate so the browser-session sanity check
  // doesn't block on Page.loadEventFired (the fake never fires it). The gate
  // tests don't reach the load-wait branch either way; this is for the
  // happy-path sanity check below.
  { tool: "navigate", handler: navTools.get("navigate")!, args: { url: "http://x", wait: "none" } },
  { tool: "reload", handler: navTools.get("reload")!, args: {} },
  { tool: "get_url", handler: navTools.get("get_url")!, args: {} },
  // dom.ts
  { tool: "query_selector", handler: domTools.get("query_selector")!, args: { selector: "#x" } },
  { tool: "get_element_html", handler: domTools.get("get_element_html")!, args: { selector: "#x" } },
  { tool: "locate", handler: domTools.get("locate")!, args: { by: "css", selector: "#x" } },
  { tool: "wait_for", handler: domTools.get("wait_for")!, args: { by: "css", selector: "#x", timeout_ms: 100 } },
  { tool: "get_form_state", handler: domTools.get("get_form_state")!, args: {} },
  { tool: "click", handler: domTools.get("click")!, args: { selector: "#x" } },
  { tool: "type_text", handler: domTools.get("type_text")!, args: { selector: "#x", text: "hi" } },
  { tool: "press_key", handler: domTools.get("press_key")!, args: { key: "Enter" } },
  { tool: "screenshot", handler: domTools.get("screenshot")!, args: {} },
  // network.ts
  { tool: "get_network_requests", handler: networkTools.get("get_network_requests")!, args: {} },
  { tool: "get_request_body", handler: networkTools.get("get_request_body")!, args: { request_id: "r1" } },
  { tool: "get_response_body", handler: networkTools.get("get_response_body")!, args: { request_id: "r1" } },
  // forms.ts
  { tool: "select_option", handler: formTools.get("select_option")!, args: { selector: "#x", option_value: "a" } },
  { tool: "check", handler: formTools.get("check")!, args: { selector: "#x" } },
  { tool: "uncheck", handler: formTools.get("uncheck")!, args: { selector: "#x" } },
  { tool: "fill", handler: formTools.get("fill")!, args: { selector: "#x", value: "hi" } },
  { tool: "suggest_locator", handler: formTools.get("suggest_locator")!, args: { selector: "#x" } },
  // storage.ts
  { tool: "export_storage_state", handler: storageTools.get("export_storage_state")!, args: { path: "/nonexistent-cdp-mcp-test-dir/x.json" } },
  { tool: "load_storage_state", handler: storageTools.get("load_storage_state")!, args: { path: "/nonexistent-cdp-mcp-test-dir/x.json" } },
  { tool: "get_cookies", handler: storageTools.get("get_cookies")!, args: {} },
  { tool: "set_cookies", handler: storageTools.get("set_cookies")!, args: { cookies: [] } },
];

describe("capability gating — Node session rejects browser-only tools", () => {
  for (const { tool, handler, args } of cases) {
    it(`${tool} returns unsupported_target when session.kind === "node"`, async () => {
      const { fake } = setupSession({ kind: "node" });
      const r = await handler.handler(args);
      const err = parseErrorEnvelope(r);
      expect(err?.error).toBe("unsupported_target");
      expect(err?.message).toBe(
        `Tool ${tool} requires a browser session (current session is node)`,
      );
      // The gate must short-circuit BEFORE any CDP send — otherwise a raw
      // "Domain not enabled" / "Method not supported" string would leak out
      // and the agent would lose the structured signal it needs to recover.
      expect(fake.sentCalls).toEqual([]);
    });
  }
});

describe("capability gating — browser session is unaffected", () => {
  // Sanity check that the gate doesn't fire spuriously. We only check the
  // error CODE (not full happy-path semantics — those live in the per-tool
  // test files). The key invariant: kind: "browser" must never produce an
  // `unsupported_target` envelope from any gated tool.
  for (const { tool, handler, args } of cases) {
    it(`${tool} does NOT return unsupported_target on a browser session`, async () => {
      setupSession({ kind: "browser" });
      const r = await handler.handler(args);
      const err = parseErrorEnvelope(r);
      // Either the tool succeeded, or it failed for some OTHER reason — what
      // it must not do is treat a browser session as the wrong kind.
      expect(err?.error).not.toBe("unsupported_target");
    });
  }
});

describe("capability gating — no_session still wins over unsupported_target", () => {
  // If there's no active session at all, the no_session error must surface
  // first regardless of kind. requireSession() runs before requireCapable()
  // in every handler, so this is structural — but worth pinning so a future
  // refactor that flips the order doesn't go unnoticed.
  for (const { tool, handler, args } of cases) {
    it(`${tool} returns no_session (not unsupported_target) when no client is wired`, async () => {
      setupSession({ noClient: true, kind: "node" });
      const r = await handler.handler(args);
      const err = parseErrorEnvelope(r);
      expect(err?.error).toBe("no_session");
    });
  }
});
