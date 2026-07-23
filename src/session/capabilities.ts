import type { SessionKind } from "./state.js";

// Per-tool kind support. Browser is the default — only tools that REJECT a
// kind need to be listed here. requireCapable() treats missing entries as
// permissive (returns without throwing).
//
// Tools land here when they depend on a CDP domain the target kind doesn't
// expose: Page / DOM / Input / Network are browser-only; Node inspector has
// Runtime + Debugger only. Runtime-only tools that don't touch the `document`
// global (evaluate, get_scope, etc.) stay permissive — they work on both.
//
// `select_target` was the first entry (self-protection during the state
// refactor); the rest of the table filled in as the session-kind split landed.
const BROWSER_ONLY: ReadonlySet<SessionKind> = new Set(["browser"]);
const NODE_ONLY: ReadonlySet<SessionKind> = new Set(["node"]);
// `Partial<Record<...>>` matches the runtime contract: missing keys are
// permissive. The non-Partial form would tell readers (and the type
// checker) that every string is a key, making the `if (!allowed) return;`
// branch in requireCapable() look like dead code instead of the central
// "permissive by default" path that it actually is.
export const TOOL_KIND_SUPPORT: Partial<Record<string, ReadonlySet<SessionKind>>> = {
  // Session targets — Node inspector has no Chrome-style page/worker targets.
  select_target: BROWSER_ONLY,
  // Navigation — Page domain.
  navigate: BROWSER_ONLY,
  reload: BROWSER_ONLY,
  get_url: BROWSER_ONLY,
  // DOM driving — DOM / Input domains, and Runtime expressions against the
  // `document` global (locate / wait_for / get_form_state would throw
  // ReferenceError in Node even though Runtime.evaluate itself works).
  query_selector: BROWSER_ONLY,
  get_element_html: BROWSER_ONLY,
  locate: BROWSER_ONLY,
  wait_for: BROWSER_ONLY,
  get_form_state: BROWSER_ONLY,
  click: BROWSER_ONLY,
  type_text: BROWSER_ONLY,
  press_key: BROWSER_ONLY,
  screenshot: BROWSER_ONLY,
  // Network buffer + body fetches — Network domain not enabled for Node, and
  // Node inspector doesn't expose Network.getRequestPostData / getResponseBody.
  get_network_requests: BROWSER_ONLY,
  get_request_body: BROWSER_ONLY,
  get_response_body: BROWSER_ONLY,
  // Form controls — same DOM / Input / `document` dependency as the dom.ts
  // tools above: option selection dispatches change events, checkbox/radio
  // toggling and LocatorSpec resolution all assume a live page DOM.
  select_option: BROWSER_ONLY,
  check: BROWSER_ONLY,
  uncheck: BROWSER_ONLY,
  fill: BROWSER_ONLY,
  suggest_locator: BROWSER_ONLY,
  // Storage state — cookies live in the browser's Network/Storage domains and
  // localStorage is a page-origin `window` global; a Node inspector session
  // exposes neither.
  export_storage_state: BROWSER_ONLY,
  load_storage_state: BROWSER_ONLY,
  get_cookies: BROWSER_ONLY,
  set_cookies: BROWSER_ONLY,
  // Framework bridge — Page pre-document injection + browser Runtime
  // execution contexts. Node has no page or React renderer lifecycle.
  attach_react_devtools: BROWSER_ONLY,
  detach_react_devtools: BROWSER_ONLY,
  get_react_tree: BROWSER_ONLY,
  find_react_component: BROWSER_ONLY,
  inspect_react_component: BROWSER_ONLY,
  // Node-only output buffer. The browser-session equivalent (Chrome stdio)
  // isn't exposed by lynceus at all, so calling get_node_output against a
  // browser session is a category error, not a "wrong session" mistake.
  get_node_output: NODE_ONLY,
};
