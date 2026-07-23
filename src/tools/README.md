# src/tools/

**Last updated: 2026-07-23**

All 56 MCP tools live here, one file per category (`react.ts` owns the opt-in React DevTools bridge; `node-output.ts` is the Node-only stdio buffer tool; `timeline.ts` merges all buffered event kinds). Every ordinary session-scoped tool accepts optional `session`; most resolve it through `requireSession(input.session)` (or `requirePaused(input.session)`), while `wait_for_pause` races all live targets when it is omitted and `get_timeline` additionally accepts the reserved value `"all"`. Among the lifecycle tools, `list_sessions` is unscoped and `close_session` addresses registry records directly. The standard error path is `{ isError: true, content: [{ text: '{"error":"<code>","message":"<msg>"}' }] }`.

## The `registerJsonTool` pattern

Every tool registers like this (see `_register.ts`):

```ts
registerJsonTool(
  server,
  "tool_name",
  "One-line description shown to the model in tools/list.",
  {
    arg_name: z.string().describe("Doc string visible to the model"),
    optional_arg: z.number().int().positive().optional(),
    session: sessionSchema,
  },
  async (input: { arg_name: string; optional_arg?: number; session?: string }) => {
    const s = requireSession(input.session); // or requirePaused(input.session) for pause-only tools
    const r = await s.client!.send("Debugger.someCommand", { /* ... */ }, sessionId);
    return { something: r.something };    // success → JSON-encoded as the tool result
    // throw new ToolError("not_found", "…") → structured error envelope
  },
);
```

## Two session axes: `session` vs `session_id`

These names address different layers and can appear together on one tool call:

| Input | Selects | Values | Default |
|---|---|---|---|
| `session` | The debug target managed by lynceus | Kind-prefixed ids such as `browser_1` / `node_1`, returned by launch/attach and `list_sessions` | The only live session; omitted with two returns `ambiguous_session` |
| `session_id` | A CDP flat child session inside the selected browser target | CDP-minted worker/iframe/OOPIF id from the originating tool response | `null` or omitted means the root CDP session |

All 50 ordinary session-scoped tools—and `close_session`—accept `session`. Eleven tools additionally accept `session_id`: `get_object_properties`, `get_request_body`, `get_response_body`, `pause`, `get_source`, `get_script_source`, `select_option`, `fill`, `check`, `uncheck`, and `suggest_locator`. Their shared schema rejects a debug-target id such as `browser_1` in `session_id` and points the caller to `session`.

`registerJsonTool` catches every exception, maps `ToolError.code` to the `error` field, packs the result with `toolJson()` (objects) or `toolText()` (strings), and logs every error to stderr via `src/util/log.ts`. You don't need to handle errors yourself unless you have a special-case envelope.

## Capability gating (browser vs Node)

Some tools only work against one session kind — browser-only tools depend on CDP domains (`Page`, `DOM`, `Input`, `Network`) or globals (`document`) that a Node Inspector session doesn't expose, and Node-only tools (`get_node_output`) target a surface that doesn't exist on a browser session. Calling either against the wrong kind returns the structured error envelope `{ error: "unsupported_target", message: "Tool <name> requires a <browser|node> session (current session is <browser|node>)" }`. The agent can recover by calling `close_session` and then the right launch/attach for the kind the tool needs.

Mechanism: each kind-restricted handler calls `requireCapable(session, "<tool_name>")` after `requireSession(input.session)`. The lookup table lives in [`src/session/capabilities.ts`](../session/capabilities.ts); tools not listed there are permissive on both kinds. Single-kind entries use the `BROWSER_ONLY` or `NODE_ONLY` set.

**Browser-only tools** (return `unsupported_target` on a Node session): `select_target`, `navigate`, `reload`, `get_url`, `query_selector`, `get_element_html`, `locate`, `wait_for`, `get_form_state`, `click`, `type_text`, `press_key`, `screenshot`, `get_network_requests`, `get_request_body`, `get_response_body`, `select_option`, `check`, `uncheck`, `fill`, `suggest_locator`, `export_storage_state`, `load_storage_state`, `get_cookies`, `set_cookies`.

**Node-only tools** (return `unsupported_target` on a browser session): `get_node_output` (`launch_node`-owned child stdio buffer).

Everything else (the `Runtime` / `Debugger` surface — breakpoints, execution stepping, frame inspection, `evaluate`, console reads, source / source-map tools) works on both kinds.

## Conventions

- **TS coordinates at the boundary.** `file` arguments are TS source paths (fragments OK — `pathMatches` is suffix-tolerant). Lines are 1-based; columns 0-based.
- **`session_id` round-trips.** Every tool that returns `object_id`, `request_id`, `script_id`, or `call_frame_id` also returns the originating `session_id` (`null` for root). The accepting follow-up tools expect you to pass it back so the call routes to the right CDP agent. **Omitting `session_id` always means "root"** — there is no fall-back-to-active-pause-session behavior. Emit `null` (not `undefined`) for root so JSON preserves the field. Never put a lynceus debug-target id (`browser_N` / `node_N`) here; that belongs in `session`.
- **Pause-only tools.** `get_call_stack`, `get_scope`, `evaluate` (with `frame_index`), `step_over` / `step_into` / `step_out` all `requirePaused()` and return `error: "not_paused"` if called outside a pause.
- **Buffered tools.** `get_console_logs`, `get_network_requests`, and `get_node_output` keep their per-session latest-N query semantics. `get_timeline` merges those retained buffers by registry-global `seq` and paginates forward (earliest rows after `since` first), so pass its returned `cursor` back with the same `session` and `event_types` selection to continue without skipping rows.
- **Compact previews.** Use `previewRemoteObject()` and `truncate()` from `src/util/format.ts`. Lists capped at sensible defaults; bodies lazy-loaded via dedicated tools, never inlined in list responses.

## Tool catalog (56 tools)

The **Kind** column reflects which session kind a tool is meaningful for. **Shared** = works on both browser and Node sessions (the Runtime + Debugger surface). **Browser** = only meaningful against a browser session — the 27 tools in `BROWSER_ONLY` (`src/session/capabilities.ts`, including `select_target`) return `error: "unsupported_target"` when called against a Node session, and `launch_chrome` / `attach_chrome` are session-startup tools listed Browser for the same affinity reason. **Node** = only meaningful against a Node session — `attach_node` / `launch_node` are session-startup, and `get_node_output` is in `NODE_ONLY` (returns `unsupported_target` on a browser session).

| File | Tool | Kind | One-line description |
|---|---|---|---|
| `session.ts` | `launch_chrome` | Browser | Launch Chrome with `--remote-debugging-port` and attach. Optional `label`; returns `{ session, label, … }`. |
| | `attach_chrome` | Browser | Attach to a running Chrome (default port 9222). Optional `label`; returns `{ session, label, … }`. |
| | `attach_node` | Node | Attach to a Node.js process started with `--inspect` / `--inspect-brk` (default port 9229, host 127.0.0.1). Optional `label`; returns `{ session, label, … }`. |
| | `launch_node` | Node | Launch a Node.js script under `--inspect` / `--inspect-brk`, attach, and own the child process. Optional `label`; returns `{ session, label, … }`. |
| | `close_session` | Shared | Close a session (optional `session` id — omit when one is live); kills the owned process if we launched it. Returns `{ session, label, status }`; idempotent `no-active-session` when nothing is live. |
| | `list_sessions` | Shared | List the live sessions (id, kind, label, attached/paused, url). The recovery tool `ambiguous_session` / `unknown_session` point at. |
| | `list_targets` | Shared | Pages, workers, iframes on the current browser (Node sessions: single root target). |
| | `select_target` | Browser | Switch the active page target. |
| `nav.ts` | `navigate` | Browser | Go to URL; waits for `load` / `domcontentloaded` / `networkidle` / `none`. |
| | `reload` | Browser | Reload the active page (optional cache bypass). |
| | `get_url` | Browser | Current top-frame URL. |
| `source.ts` | `list_scripts` | Shared | Parsed scripts with source-map status. |
| | `get_script_source` | Shared | Raw generated (JS) source by script ID — compiled JS, NOT set_breakpoint coordinates. |
| | `get_source` | Shared | Original **TypeScript** source by TS path/fragment (via source maps: embedded `sourcesContent`, else on-disk for loopback). Read TS line numbers for set_breakpoint here, not from get_script_source. |
| | `resolve_source_position` | Shared | TS → JS coordinate translation (diagnostic; useful when a breakpoint didn't bind). |
| `breakpoints.ts` | `set_breakpoint` | Shared | Set in TS source; binds in every mapping script (page + workers + iframes). Optional `condition`, `log_message` (logpoint). Idempotent: identical re-call returns same id with `status: "already-set"`; same location + different condition/log_message returns `error: "breakpoint_conflict"`. |
| | `remove_breakpoint` | Shared | Remove by ID. |
| | `list_breakpoints` | Shared | All active breakpoints + resolved JS locations. |
| | `set_pause_on_exceptions` | Shared | `none` / `uncaught` / `all`; replayed to newly-attached children. |
| `execution.ts` | `resume` | Shared | Dispatched to the session that paused (root, worker, OOPIF, …). |
| | `step_over` | Shared | Step over; awaits the next pause (or returns `paused:false` on timeout). |
| | `step_into` | Shared | Step into the next call. |
| | `step_out` | Shared | Step out of the current function. |
| | `pause` | Shared | Pause manually; `session_id` arg targets a worker/iframe. |
| | `wait_for_pause` | Shared | Block until the debugger pauses (or times out). Explicit `session` scopes the wait; omission snapshots and races the usable targets live at call start, and an already-paused participant can win immediately. The raced response returns the winner's `session` + `label`. |
| `inspect.ts` | `get_call_stack` | Shared | TS-mapped frames with `session_id` per frame. |
| | `get_scope` | Shared | Variables at a paused frame. Default (no `scope_type`) returns the merged lexical view (inner block/catch/with + function local, innermost wins), so block-scoped `let`/loop vars are included; pass a `scope_type` to read exactly one scope. |
| | `evaluate` | Shared | Auto-routes: paused → `Debugger.evaluateOnCallFrame` on the top frame (override with `frame_index`); not paused → `Runtime.evaluate`. `frame_index` while not paused → `not_paused`. |
| | `get_object_properties` | Shared | Inspect a `RemoteObject` by ID. Strict `session_id` provenance. |
| `console.ts` | `get_console_logs` | Shared | Buffered console + uncaught exceptions; filter by `level` / `search`; paginate via `since`. |
| | `clear_console` | Shared | Clear the buffered stream (does NOT clear the runtime's own console). |
| `network.ts` | `get_network_requests` | Browser | Buffered requests (no bodies); filter / paginate / lifecycle gates. |
| | `get_request_body` | Browser | Lazy body fetch. |
| | `get_response_body` | Browser | Lazy; safe ONLY when `finished:true` AND `failure` absent. Binary stays base64 (never UTF-8-corrupted, never truncated — truncate text only). |
| `node-output.ts` | `get_node_output` | Node | Buffered stdout/stderr from a `launch_node`-owned Node child. Pull-based with `since` cursor (mirrors `get_console_logs`). Filter by `stream` (stdout/stderr) and `search`. Separate from `get_console_logs` — that's the V8 inspector's `Runtime.consoleAPICalled` stream; this is the OS-level pipe. Populated only on `launch_node` sessions; `attach_node` leaves it empty. |
| `timeline.ts` | `get_timeline` | Shared | Merge console, network request-start, and Node-output rows by registry-global `seq`. `session: "all"` spans both targets; forward pagination applies `limit` after the merge and is lossless while the session/event filters stay unchanged. |
| `react.ts` | `attach_react_devtools` | Browser | Opt in to the pinned React DevTools backend for the addressed main-frame React tree. Installs the CDP binding + pre-document bridge, reloads, and waits for the bootstrap sentinel plus first structural `operations` event. Idempotent after attachment. |
| | `detach_react_devtools` | Browser | Unsubscribe the React backend; remove future-document scripts and binding registrations; clear bridge state and fence late events. Idempotent when already detached. |
| `dom.ts` | `query_selector` | Browser | `nodeId` + preview. |
| | `get_element_html` | Browser | Outer or inner HTML. |
| | `locate` | Browser | Structured LocatorSpec search (CSS, text, role, test-id, label, placeholder, name). |
| | `wait_for` | Browser | Poll until a LocatorSpec reaches the requested DOM state (visible/hidden/attached/detached). |
| | `get_form_state` | Browser | Read named form fields; supports radio groups, checkboxes, multi-selects. |
| | `click` | Browser | Synthetic mouse events to the element center. |
| | `type_text` | Browser | Focus + `Input.insertText`. |
| | `press_key` | Browser | `Input.dispatchKeyEvent` keydown/keyup. |
| | `screenshot` | Browser | Base64 PNG or save to `path`. |
| `forms.ts` | `select_option` | Browser | Set a native `<select>` by `option_value` / `option_label` / `option_index`; dispatches input + change. Returns `status: "selected"`. |
| | `check` | Browser | Ensure a checkbox/radio is checked (idempotent: `status: "checked" \| "already-checked"`). |
| | `uncheck` | Browser | Ensure a checkbox/radio is unchecked (idempotent: `status: "unchecked" \| "already-unchecked"`). |
| | `fill` | Browser | Set an input/textarea/contenteditable (LocatorSpec) to exactly a value, replacing contents; dispatches input + change. |
| | `suggest_locator` | Browser | Rank stable LocatorSpec candidates for an element (by `node_id` or `selector`), with per-candidate match counts. |
| `storage.ts` | `export_storage_state` | Browser | Save cookies (incl. HttpOnly) + current-origin localStorage to a Playwright-shaped JSON file. |
| | `load_storage_state` | Browser | Restore cookies + matching-origin localStorage from a storageState file (resume a session). |
| | `get_cookies` | Browser | List cookies with flags; redacts likely session/auth values for display. |
| | `set_cookies` | Browser | Set cookies in the browser jar via CDP (each needs a url or domain). |

Plus `_register.ts` — the registration helper, not itself a tool, and `_locator_runtime.ts` — the shared in-page locator script (helpers/read/mutation) used by `dom.ts` + `forms.ts`.

## Adding a new MCP tool

1. **Define Zod schemas** — input shape with `.describe()` strings (those strings are what the model sees). Keep tool names `snake_case`.
2. **Write the handler** — add `session: sessionSchema`, resolve with `requireSession(input.session)` (or `requirePaused(input.session)`), make CDP calls, and return a plain object or string. Throw `ToolError(code, message)` for known errors.
3. **Wrap with `registerJsonTool`** inside the appropriate `registerXxxTools(server)`. If it's a new category, add a `registerXxxTools` call to `src/server.ts`.
4. **Round-trip `session_id`** if your tool returns any per-agent ID (`object_id`, `request_id`, `script_id`, `call_frame_id`). Emit `null` for root so JSON preserves the field.
5. **Gate on session kind** if the tool depends on a browser-only CDP domain or global. Add an entry to `TOOL_KIND_SUPPORT` in [`src/session/capabilities.ts`](../session/capabilities.ts) and call `requireCapable(s, "<tool_name>")` after `requireSession(input.session)`. Update the "Browser-only tools" list above and add a row to `test/tools/capabilities.test.ts`.
6. **Add an L2 contract test** in `test/tools/<file>.test.ts` against `test/fake-cdp.ts` — and add a row to this README's catalog.

**LLM-caller UX: avoid `is_error: true` for no-op-already-applied cases.** `is_error: true` (Anthropic tool-use `is_error`) is a strong "try something different" signal that can burn iterations when the right move was to proceed. Two precedents for the idempotent shape in this repo: `select_target` returns `status: "already-active" | "switched"` on the success envelope (`src/tools/session.ts`), and `set_breakpoint` returns `status: "set" | "already-set"` plus a distinct `breakpoint_conflict` error code when the same location is set with a different `condition`/`log_message` (surfaced by an L4 eval trial).
