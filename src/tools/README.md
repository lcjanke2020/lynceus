# src/tools/

**Last updated: 2026-05-19**

All 44 MCP tools live here, one file per category. Every tool wraps `requireSession()` (or `requirePaused()`), makes one or more CDP calls, and returns a structured JSON envelope. The standard error path is `{ isError: true, content: [{ text: '{"error":"<code>","message":"<msg>"}' }] }`.

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
  },
  async (input: { arg_name: string; optional_arg?: number }) => {
    const s = requireSession();           // or requirePaused() for paused-only tools
    const r = await s.client!.send("Debugger.someCommand", { /* ... */ }, sessionId);
    return { something: r.something };    // success → JSON-encoded as the tool result
    // throw new ToolError("not_found", "…") → structured error envelope
  },
);
```

`registerJsonTool` catches every exception, maps `ToolError.code` to the `error` field, packs the result with `toolJson()` (objects) or `toolText()` (strings), and logs every error to stderr via `src/util/log.ts`. You don't need to handle errors yourself unless you have a special-case envelope.

## Conventions

- **TS coordinates at the boundary.** `file` arguments are TS source paths (fragments OK — `pathMatches` is suffix-tolerant). Lines are 1-based; columns 0-based.
- **`session_id` round-trips.** Every tool that returns `object_id`, `request_id`, `script_id`, or `call_frame_id` also returns the originating `session_id` (`null` for root). The follow-up tool (`get_object_properties`, `get_request_body`, `get_response_body`, `get_script_source`, `evaluate` with `frame_index`) expects you to pass it back so the call routes to the right CDP agent. **Omitting `session_id` always means "root"** — there is no fall-back-to-active-pause-session behavior. Emit `null` (not `undefined`) for root so JSON preserves the field.
- **Pause-only tools.** `get_call_stack`, `get_scope`, `evaluate` (with `frame_index`), `step_over` / `step_into` / `step_out` all `requirePaused()` and return `error: "not_paused"` if called outside a pause.
- **Buffered tools** (`get_console_logs`, `get_network_requests`) paginate via `since` cursor — pass back the previous `cursor` value to get only new entries.
- **Compact previews.** Use `previewRemoteObject()` and `truncate()` from `src/util/format.ts`. Lists capped at sensible defaults; bodies lazy-loaded via dedicated tools, never inlined in list responses.

## Tool catalog (44 tools)

| File | Tool | One-line description |
|---|---|---|
| `session.ts` | `launch_chrome` | Launch Chrome with `--remote-debugging-port` and attach. |
| | `attach_chrome` | Attach to a running Chrome (default port 9222). |
| | `close_session` | Close the CDP session; kill Chrome if we launched it ourselves. |
| | `list_targets` | Pages, workers, iframes on the current browser. |
| | `select_target` | Switch the active page target. |
| `nav.ts` | `navigate` | Go to URL; waits for `load` / `domcontentloaded` / `networkidle` / `none`. |
| | `reload` | Reload the active page (optional cache bypass). |
| | `get_url` | Current top-frame URL. |
| `source.ts` | `list_scripts` | Parsed scripts with source-map status. |
| | `get_script_source` | Raw generated (JS) source by script ID. |
| | `resolve_source_position` | TS → JS coordinate translation (diagnostic; useful when a breakpoint didn't bind). |
| `breakpoints.ts` | `set_breakpoint` | Set in TS source; binds in every mapping script (page + workers + iframes). Optional `condition`, `log_message` (logpoint). Idempotent: identical re-call returns same id with `status: "already-set"`; same location + different condition/log_message returns `error: "breakpoint_conflict"`. |
| | `remove_breakpoint` | Remove by ID. |
| | `list_breakpoints` | All active breakpoints + resolved JS locations. |
| | `set_pause_on_exceptions` | `none` / `uncaught` / `all`; replayed to newly-attached children. |
| `execution.ts` | `resume` | Dispatched to the session that paused (root, worker, OOPIF, …). |
| | `step_over` | Step over; awaits the next pause (or returns `paused:false` on timeout). |
| | `step_into` | Step into the next call. |
| | `step_out` | Step out of the current function. |
| | `pause` | Pause manually; `session_id` arg targets a worker/iframe. |
| | `wait_for_pause` | Block until the debugger pauses (or times out). Authoritative sync point. |
| `inspect.ts` | `get_call_stack` | TS-mapped frames with `session_id` per frame. |
| | `get_scope` | Variables at a paused frame (`local` default; other scope types selectable). |
| | `evaluate` | Auto-routes: paused → `Debugger.evaluateOnCallFrame` on the top frame (override with `frame_index`); not paused → `Runtime.evaluate`. `frame_index` while not paused → `not_paused`. |
| | `get_object_properties` | Inspect a `RemoteObject` by ID. Strict `session_id` provenance. |
| `console.ts` | `get_console_logs` | Buffered console + uncaught exceptions; filter by `level` / `search`; paginate via `since`. |
| | `clear_console` | Clear the buffered stream (does NOT clear Chrome's own console). |
| `network.ts` | `get_network_requests` | Buffered requests (no bodies); filter / paginate / lifecycle gates. |
| | `get_request_body` | Lazy body fetch. |
| | `get_response_body` | Lazy; safe ONLY when `finished:true` AND `failure` absent. Binary stays base64 (never UTF-8-corrupted, never truncated — truncate text only). |
| `dom.ts` | `query_selector` | `nodeId` + preview. |
| | `get_element_html` | Outer or inner HTML. |
| | `locate` | Structured LocatorSpec search (CSS, text, role, test-id, label, placeholder, name). |
| | `wait_for` | Poll until a LocatorSpec reaches the requested DOM state (visible/hidden/attached/detached). |
| | `get_form_state` | Read named form fields; supports radio groups, checkboxes, multi-selects. |
| | `click` | Synthetic mouse events to the element center. |
| | `type_text` | Focus + `Input.insertText`. |
| | `press_key` | `Input.dispatchKeyEvent` keydown/keyup. |
| | `screenshot` | Base64 PNG or save to `path`. |
| `forms.ts` | `select_option` | Set a native `<select>` by `option_value` / `option_label` / `option_index`; dispatches input + change. Returns `status: "selected"`. |
| | `check` | Ensure a checkbox/radio is checked (idempotent: `status: "checked" \| "already-checked"`). |
| | `uncheck` | Ensure a checkbox/radio is unchecked (idempotent: `status: "unchecked" \| "already-unchecked"`). |
| | `fill` | Set an input/textarea/contenteditable (LocatorSpec) to exactly a value, replacing contents; dispatches input + change. |
| | `suggest_locator` | Rank stable LocatorSpec candidates for an element (by `node_id` or `selector`), with per-candidate match counts. |

Plus `_register.ts` — the registration helper, not itself a tool, and `_locator_runtime.ts` — the shared in-page locator script (helpers/read/mutation) used by `dom.ts` + `forms.ts`.

## Adding a new MCP tool

1. **Define Zod schemas** — input shape with `.describe()` strings (those strings are what the model sees). Keep tool names `snake_case`.
2. **Write the handler** — `requireSession()` (or `requirePaused()`), make CDP calls, return a plain object or string. Throw `ToolError(code, message)` for known errors.
3. **Wrap with `registerJsonTool`** inside the appropriate `registerXxxTools(server)`. If it's a new category, add a `registerXxxTools` call to `src/server.ts`.
4. **Round-trip `session_id`** if your tool returns any per-agent ID (`object_id`, `request_id`, `script_id`, `call_frame_id`). Emit `null` for root so JSON preserves the field.
5. **Add an L2 contract test** in `test/tools/<file>.test.ts` against `test/fake-cdp.ts` — and add a row to this README's catalog.

**LLM-caller UX: avoid `is_error: true` for no-op-already-applied cases.** `is_error: true` (Anthropic tool-use `is_error`) is a strong "try something different" signal that can burn iterations when the right move was to proceed. Two precedents for the idempotent shape in this repo: `select_target` returns `status: "already-active" | "switched"` on the success envelope (`src/tools/session.ts`), and `set_breakpoint` returns `status: "set" | "already-set"` plus a distinct `breakpoint_conflict` error code when the same location is set with a different `condition`/`log_message` (surfaced by an L4 eval trial).
