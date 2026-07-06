# lynceus — original design notes

> Snapshot of the design plan written before any code landed. Captures the architectural decisions, trade-offs, and tool surface that shaped the v1 implementation. Implementation has since evolved through several reviewer-driven iterations (sessionId discipline across the multi-target story is the biggest evolution); the current code is the source of truth. This document is preserved as the "why we built it this way" artifact.

## Context

The goal: a Model Context Protocol (MCP) server that lets an AI agent (Claude Code, Copilot CLI, etc.) **debug** a running web frontend — not just automate it. The agent should set breakpoints in TypeScript source, step through code, inspect the live call stack and scope variables, evaluate expressions at a paused frame, and query buffered console + network activity. Users have source + source maps locally, so all file coordinates flow in **TS terms** and the server translates to JS for CDP under the hood.

### Prior art (worth knowing before we build)
- [`InDate/cdp-tools-mcp`](https://github.com/InDate/cdp-tools-mcp) — closest match: breakpoints, stepping, source maps, console/network.
- [`ScriptedAlchemy/devtools-debugger-mcp`](https://github.com/ScriptedAlchemy/devtools-debugger-mcp) — full debugger surface, but Node-focused.
- [`ChromeDevTools/chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) — automation + console + source-mapped stacks, **no** interactive breakpoints/stepping.
- [`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp), puppeteer reference server — automation only.

> If `cdp-tools-mcp` covers your workflow as-is, you can just install it. The design below is what to build for an opinionated, agent-first surface you own and can shape.

### Reasonable-call assumptions
- **Target browser**: Chrome/Chromium only (Firefox's CDP is a partial shim). Edge/Brave work since they're Chromium-based.
- **Modes**: Both launch-new and attach-existing (`--remote-debugging-port`).
- **Scope**: Browser pages only (not Node.js). Iframes + workers auto-attached underneath.
- **Concurrency**: One active target at a time, with `select_target` to switch.
- **Transport**: stdio (default; native for Claude Code / Copilot CLI) or SSE (`--port` flag; for persistent service mode).
- **Language**: TypeScript, npm.

## Stack
- `@modelcontextprotocol/sdk` (1.29+) — `McpServer` + Zod schemas + `StdioServerTransport` + `SSEServerTransport`.
- `chrome-remote-interface` — 1:1 CDP binding; cleanest full access to `Debugger.*`, `Runtime.*`, `Network.*`, `Page.*`, `DOM.*`, `Target.*`.
- `@jridgewell/source-map` — bidirectional source-map translation (faster + better maintained than Mozilla `source-map`).
- `chrome-launcher` — for launch-new mode.

## Project layout

```
lynceus/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                # bootstrap, stdio/SSE transport, arg parsing, signal handling
│   ├── server.ts               # tool registration table + error wrapping
│   ├── session/
│   │   ├── browser.ts          # launch / attach / close — CRI client lifecycle
│   │   ├── targets.ts          # Target.setAutoAttach for iframes + workers
│   │   ├── pause.ts            # pause-state machine + wait_for_pause queue
│   │   └── buffers.ts          # ring buffers: console messages, network requests
│   ├── sourcemap/
│   │   ├── cache.ts            # per-scriptId map cache, loaded on Debugger.scriptParsed
│   │   ├── translate.ts        # TS↔JS, with webpack:/// + sourceRoot normalization
│   │   └── resolve.ts          # TS-file → candidate scripts (reverse index)
│   ├── tools/
│   │   ├── session.ts          # launch_chrome, attach_chrome, close, list/select_target
│   │   ├── nav.ts              # navigate, reload, get_url
│   │   ├── breakpoints.ts      # set/remove/list, set_pause_on_exceptions
│   │   ├── execution.ts        # resume, step_over/into/out, pause, wait_for_pause
│   │   ├── inspect.ts          # get_call_stack, get_scope, evaluate, get_object_properties
│   │   ├── console.ts          # get_console_logs, clear_console
│   │   ├── network.ts          # get_network_requests, get_request_body, get_response_body
│   │   ├── dom.ts              # query_selector, get_element_html, click, type, screenshot
│   │   └── source.ts           # list_scripts, get_script_source, resolve_source_position
│   └── util/
│       ├── log.ts              # stderr-only logging (stdout reserved for JSON-RPC)
│       └── format.ts           # compact result shapes (low context cost)
└── examples/
    └── sample-app/             # tiny vite+ts app with a deliberate bug — for verification
```

## Tool surface (designed for agent usability)

Naming: `verb_noun`, snake_case. Inputs/outputs are flat JSON. File coordinates are always **TS** unless the parameter is a `script_id` or the tool name ends in `_js`.

### Session
- `launch_chrome(url?, headless=false, user_data_dir?, args?)`
- `attach_chrome(port=9222, target_filter?)`
- `close_session()`
- `list_targets()` → `[{id, type, url, title, attached}]`
- `select_target(id)`

### Navigation
- `navigate(url, wait="load")` — supports `load` / `domcontentloaded` / `networkidle`
- `reload(hard=false)`
- `get_url()`

### Breakpoints (TS-aware)
- `set_breakpoint(file, line, column?, condition?, log_message?)` — `file` is TS; server resolves script(s), translates via source map, calls `Debugger.setBreakpointByUrl`. Returns `{id, resolvedLocations: [{file, line, column}]}`. If ambiguous, returns all candidates.
- `remove_breakpoint(id)`
- `list_breakpoints()`
- `set_pause_on_exceptions(state: "none"|"uncaught"|"all")`

### Execution control
- `resume()`
- `step_over()` / `step_into()` / `step_out()` — each internally awaits the next `Debugger.paused` or resume
- `pause()` (manual)
- `wait_for_pause(timeout_ms=30000)` — authoritative sync point, returns:
  ```
  {
    reason: "breakpoint"|"exception"|"step"|"pause"|"other",
    callStack: [{frameId, file, line, column, functionName,
                 scope: [{type, name}]}],   // TS-mapped
    data?: {…}    // for exceptions: error message + object id
  }
  ```

### Inspection (valid only while paused)
- `get_call_stack()`
- `get_scope(frame_index, scope_type="local"|"closure"|"global", max_props=50)` → `[{name, type, preview, objectId?}]`
- `evaluate(expression, frame_index?, return_by_value=false)` — frame-aware when paused
- `get_object_properties(object_id, max_depth=1, max_props=50)`

### Console (buffered)
- `get_console_logs({since?, level?, search?, limit=100})` — each entry includes mapped source location
- `clear_console()`

### Network (buffered)
- `get_network_requests({since?, status?, type?, url_match?, limit=50})` — compact summary; lazy-load bodies
- `get_request_body(request_id)`
- `get_response_body(request_id)`

### DOM / light interaction (so the agent can drive a flow to a breakpoint)
- `query_selector(css)` → `{nodeId, tag, attrs, text_preview}`
- `get_element_html(selector_or_node_id, outer=true)`
- `click(selector)` / `type(selector, text)` / `press_key(key)`
- `screenshot({full_page=false, return="base64"|"file", path?})`

### Source / diagnostics
- `list_scripts({mapped_only=true})` → `[{scriptId, url, has_map, originalSources?}]`
- `get_script_source(script_id)`
- `resolve_source_position(file, line, column?)` → JS coord (debug helper for "why didn't my breakpoint bind?")

## Critical design points

1. **Pause-state lifecycle.** `frameId` and `objectId` are valid only between `Debugger.paused` and the next resume. Server tracks pause state; `get_scope` while not paused returns a clean `not_paused` error rather than a raw CDP failure.

2. **Source-map index built on the fly.** Subscribe to `Debugger.scriptParsed`; if `sourceMapURL` is set, fetch it (data URI, HTTP, or via `Network.loadNetworkResource` to reuse the page's network stack), parse with `@jridgewell/source-map`, store keyed by `scriptId`. Build a reverse index `originalSourcePath → [scriptId, …]` for breakpoint resolution.

3. **TS path matching is fuzzy.** Bundlers emit `webpack:///./src/foo.ts`, `./src/foo.ts`, `/src/foo.ts`, `webpack-internal:///`, file URLs, etc. Strip known prefixes and match by trailing segments. When ambiguous, return all candidate `resolvedLocations` and let the agent disambiguate by passing a more specific path.

4. **Buffered, queryable events.** Console + network are streams; MCP is call/response. Keep ring buffers (~1000 each) tagged with a monotonic `seq` so the agent can paginate via `since`. Do **not** stream — agents prefer pull semantics.

5. **Auto-attach to iframes + workers.** `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`. Maintain per-target sub-sessions so a breakpoint in a worker pauses correctly.

6. **Compact returns.** Trim previews to ~200 chars, cap arrays in scope listings, lazy-load big strings via dedicated body tools. Big payloads kill agent context windows.

7. **Stdout discipline.** stdio transport reserves stdout for JSON-RPC. Route all logging to stderr — set up a logger in `util/log.ts` and never call bare `console.log`.

8. **Concurrent-pause races.** If the agent fires `step_over` then immediately `get_scope`, the second call may land before `Debugger.paused` re-fires. The step tools internally await the next pause-or-resume; `wait_for_pause` is the documented sync point.

## Verification (original plan)

1. **Build the sample app** (`examples/sample-app`): Vite + TS + a button whose click handler has a deliberate off-by-one bug.
2. `pnpm build && pnpm dev` the sample on `:5173`.
3. Add the MCP server to Claude Code (e.g. `claude mcp add lynceus node /abs/path/dist/index.js` or via settings JSON).
4. **Scripted end-to-end test** (the canonical agent flow):
   - `launch_chrome(url="http://localhost:5173")`
   - `set_breakpoint(file="src/handlers.ts", line=12)`
   - `click(selector="#go")`
   - `wait_for_pause()` → expect a frame at `src/handlers.ts:12` (TS coords, not JS)
   - `get_scope(0, "local")` → expect to see the buggy variable
   - `evaluate("count + 1", 0)` → expect `2`
   - `resume()`
5. **Source-map regression suite** (vitest): table-driven cases for `webpack:///`, `sourceRoot`, missing-map, inline data-URI map, nested map (TS → JS → bundled).
6. **Manual happy path with Claude Code**: ask "Find why `<feature>` is broken" in a real TS app you have handy, confirm the agent uses the tools end-to-end with no special prompting beyond an MCP description.

## Out of scope for v1 (easy to add later)
- Firefox / Safari.
- Node.js debugging (different attach flow; same CDP).
- `Storage.*` (cookies, IndexedDB, localStorage tools).
- Performance tracing (`Tracing.*`).
- Memory snapshots / heap profiling (`HeapProfiler.*`).
- Multi-page concurrent debugging (single active target is the v1 contract).

## What the implementation discovered after this plan

A few things the original plan got right and a few it got wrong, recorded here for posterity:

- **Source-map line-numbering**: three different conventions coexist (user 1-based, source-map 1-based, CDP 0-based). The plan called this out as a critical design point but underweighted how many `+1/-1` sites it would touch. Every reviewer iteration touched at least one.
- **The CRI typed-send overload trap**: `client.send("Method", params as any)` silently picks the void-returning callback overload. Not mentioned in the original plan; cost an afternoon early on. Fix is to drop `as any` and let the typed Promise overload pick.
- **sessionId discipline is the hard part of multi-target.** The plan said "auto-attach to iframes + workers" as if it were one bullet. In practice it took three rounds of reviewer iteration to thread sessionId provenance through every state surface AND every dispatch site. Pattern: data is session-aware, dispatch is session-naive; this asymmetry recurs and needs systematic auditing per `client.send` call site, not just per feature.
- **JSON.stringify drops `undefined`.** Emitting `session_id: undefined` for root entries means the field disappears on the wire, which means agents can't round-trip it, which means downstream tools mis-route. Fix: emit `null` for root explicitly. Not anticipated.
- **Network in-flight tracking** needs an escape valve for persistent connections (WebSocket, EventSource). Original plan said "settle after 500ms of no events" — that's wrong; it needs to be "settle after 500ms with the in-flight set empty, ignoring persistent-connection types." Universal failure mode without it because every Vite dev server opens an HMR WebSocket.

These are the kind of things only iterative reviewer feedback catches. The plan was a good map; the territory had landmines.
