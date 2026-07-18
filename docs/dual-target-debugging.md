# Dual-target full-stack debugging — design

> Design doc for **concurrent browser + Node sessions** (LEO-115). Companion to
> [`docs/node-session-design.md`](./node-session-design.md) — that doc took the server
> from browser-only to browser-*or*-Node under a single-session invariant; this one
> removes the invariant so one agent can hold both kinds of session open at once and
> trace a bug end-to-end across the stack.
>
> **Status: design locked ahead of implementation.** The engineering lands on the
> `multi-session-support` feature branch: the core registry refactor + session
> addressing (LEO-116), then raced waits + merged timelines + the full-stack eval
> scenario (LEO-365). §12 maps the PR slicing.

## 1. Goal + non-goals

### Goal

Let one agent drive **one browser session and one Node session concurrently** through a
single lynceus server. The killer flow: breakpoint both the React click handler and the
Express route handler, click in the browser, watch the handler run, follow the
`fetch("/api/cart")` over the wire, land in the Node route's breakpoint, step through the
bug, resume, and watch the browser render the consequence. No existing agent-facing tool
does this cleanly.

Everything below is in service of that flow staying *narratable*: every id an agent sees
should say what it is (`browser_1`, `node_1`, labels like `frontend`/`backend`), every
error should say how to recover, and single-session usage — the overwhelmingly common
case — must keep working with zero extra ceremony.

### Non-goals (v1)

- **More than one session per kind.** v1 caps the registry at one browser + one Node
  session. The mechanism (registry keyed by session id) generalizes to N; the cap is a
  product decision to keep `ambiguous_session` handling and the demo story simple.
  Kind-prefixed ids (`browser_N`) are forward-compatible with lifting it (v2).
- **Multi-tab / multi-page within the browser session.** Unchanged from today
  (`select_target` switches the single browser session between targets).
- **Cross-request trace propagation** (e.g. injecting an `X-Agent-Debug-Id` header on
  browser fetches and matching it on the Node side). The v1 correlation floor is merged
  timelines (§7); header propagation is flagged as a future enhancement.
- **Multi-client SSE.** `runSseServer` builds a fresh McpServer per connection but all
  connections share process state. That is documented-unsupported today and stays so;
  the registry neither fixes nor worsens it.

## 2. Session addressing model

### Decision: optional `session` parameter, defaulting to the only live session

Every session-scoped tool gains an **optional `session: string`** input:

- **Omitted with exactly one live session** → targets that session. This is the
  compatibility path: every existing single-session transcript, test, and eval keeps
  working unchanged.
- **Omitted with two live sessions** → structured `ambiguous_session` error listing the
  candidates (§10). Exception: `wait_for_pause`, whose omitted form is a *race* across
  all sessions (§6).
- **Omitted with zero sessions** → `no_session`, exactly as today. One deliberate
  exception: `close_session` keeps its idempotent zero-session *success* (§5) — today
  it returns `"no active session"`, not an error, and closing nothing stays a no-op.
- **Explicit `session` that doesn't exist** → `unknown_session` listing live sessions.

Rejected alternatives (from the ticket, confirmed here):

- *Per-kind tool namespaces* (`browser_set_breakpoint` / `node_set_breakpoint`) — doubles
  a 52-tool catalog, and the split is wrong: most tools are kind-agnostic.
- *A `select_session` mode switch* — stateful; an interleaved transcript (the whole point
  of dual-session debugging) would thrash the selector, and a forgotten switch targets
  the wrong side silently. The `session` parameter keeps every call self-describing.

### The name is `session` — never `session_id`

`session_id` **already means something else in this codebase**: the CDP *child*-session
axis (workers, iframes, OOPIFs) under one browser target. The two axes coexist and
compose — a dual-session agent stepping into a worker uses both on one call.

| | `session` (NEW — this design) | `session_id` (existing) |
|---|---|---|
| Axis | Which **debug target** (browser vs Node process) | Which **CDP flat session** *within* the browser target (root page, worker, iframe) |
| Values | `browser_1`, `node_1` (kind-prefixed, §3) | CDP-minted GUIDs; omitted = root. Explicit `null` = root is accepted today by 6 of the 11 accepting tools (`.nullable().optional()` schemas); the five forms tools are `.optional()`-only and reject `null` — PR 5 unifies all 11 to `.nullable().optional()` |
| Appears on | Every session-scoped tool (~45) | Input on 11 tools: `get_object_properties`, `get_request_body`, `get_response_body`, `pause`, `get_source`, `get_script_source`, `select_option`, `fill`, `check`, `uncheck`, `suggest_locator`; returned by every tool that mints CDP object/script/request/frame ids (`list_scripts`, `get_source`, `get_script_source`, `resolve_source_position`, `get_call_stack`, `get_scope`, `evaluate`, `get_object_properties`, `get_network_requests`, the pause summaries) |
| Default | The only live session; `ambiguous_session` if two | Root session — omitting **never** falls back to "wherever we paused" |
| Node sessions | `node_1` is a first-class value | Always root (Node has no child sessions in v1) |

Correction to the planning notes, from reading the code: the planning notes' four-tool
list (`evaluate`, `get_object_properties`, `get_network_requests`, `pause`) was wrong in
both directions. Out: `evaluate` (auto-routes through the paused frame's own session and
takes `frame_index`) and `get_network_requests` (returns per-item `session_id` but does
not accept one). In: seven tools the notes missed — `get_source` / `get_script_source`
(`src/tools/source.ts`) and `select_option` / `fill` / `suggest_locator` / `check` /
`uncheck` (`src/tools/forms.ts`; check + uncheck share one `registerToggle` schema
site). The full accepting set is the **11 tools** in the table above. The declarations
split two ways, and PR 5's amendment pass unifies both: **phrasing** — the five
`forms.ts` tools say "Target a worker/iframe session…", while `source.ts` uses the
"From list_scripts … null or omitted = root" family shared with network/inspect/
execution (three phrasings in all, which is why quick surveys undercount) — and
**schema shape** — the six network/inspect/execution/source declarations are
`z.string().nullable().optional()` (explicit `null` = root), while the five forms
declarations are `z.string().optional()` and reject explicit `null`. PR 5 moves all 11
to `.nullable().optional()` with one shared description. The disambiguation
table (or a condensed form) ships in all eleven tool descriptions and in
`src/tools/README.md`. The kind-prefixed id format is deliberately unconfusable with a
CDP GUID, and a cheap L2 test pins the failure mode: `session_id: "browser_1"` must
fail with a message pointing at the `session` parameter.

## 3. Session identity: ids and labels

- **Ids are kind-prefixed and ordinal:** `browser_1`, `node_1` — minted by the registry
  at launch/attach, monotonically per kind for the life of the process (a second Node
  session after `close_session(session:"node_1")` is `node_2`, not a recycled `node_1`;
  stale ids must never silently alias a new session).
- **Labels are optional, agent-supplied at launch/attach** (`label: "frontend"`),
  surfaced in every place a session is named: lifecycle returns, `list_sessions`,
  `ambiguous_session`/`unknown_session` candidate lists, pause events, merged-timeline
  rows. Uniqueness rule: labels must be unique among *live* sessions; a duplicate label
  is rejected at launch/attach with `duplicate_label` (cheap to enforce, and a transcript
  where "frontend" is ambiguous defeats the purpose of labels).
- **Labels are not addresses.** Tools accept only the id in `session`. Accepting labels
  too reads nicely but creates a second alias space and a rename hazard; ids are short
  enough. (Revisit in v2 if transcripts show agents copying labels into `session`.)

## 4. The `SessionRegistry`

### What today's architecture already gives us

Every piece of per-session state is **already an instance field on `SessionState`** —
`PauseTracker`, all three ring buffers (console, network, node-output), the
`ScriptStore`, breakpoint records, per-CDP-child handler refs (`sessionHandlers`),
`pauseOnExceptions`, `kind`, `attached`, `ownedProcess`. There are no module-level
mutable caches in the session or sourcemap paths that could leak between two concurrent
instances (the only module-level mutable state found is an env-warning dedup set in
`src/util/env.ts`, which is not session data). The singleton is only the *slot*:

- `export const sessionState = new SessionState()` — the one shared instance,
- three accessors (`getSession` / `requireSession` / `requirePaused`) that read it,
- four `alreadySession()` guards (2 in `browser.ts`, 2 in `node.ts`) that enforce
  one-at-a-time,
- `debugger.ts` handlers and shutdown paths that close over the import.

The refactor therefore replaces a *slot*, not a data model.

### Registry shape

```ts
// src/session/state.ts — the registry is CO-LOCATED with the (still un-exported)
// SessionState class; that co-location is what lets the class stay un-exported
// while the registry remains its sole minting path.
// Sketch; signatures are the contract, names indicative.
export type SessionId = string; // "browser_1" | "node_1" | ...
export type SessionStatus = "starting" | "active" | "closing";

interface SessionRecord {
  id: SessionId;
  kind: SessionKind;
  label?: string;
  status: SessionStatus;
  state: SessionState;
}

class SessionRegistry {
  private records = new Map<SessionId, SessionRecord>();
  private counters: Record<SessionKind, number> = { browser: 0, node: 0 };
  private globalSeq = 0; // §7 — timeline ordering

  reserve(kind: SessionKind, label?: string): SessionRecord;
  //   mints the id and a fresh SessionState with status "starting". The per-kind
  //   capacity check and label-uniqueness check run HERE, counting reservations —
  //   two concurrent same-kind launches cannot both pass.
  activate(id: SessionId): void;    // "starting" → "active"; only now visible to tools
  abort(id: SessionId): Promise<void>;
  //   rollback for a failed launch/attach: closes the partial state (kills an owned
  //   process if one was spawned) and deletes the reservation, freeing capacity.
  get(id?: SessionId): SessionState;      // resolution rules of §2 — ACTIVE records only
  list(): SessionSummary[];               // active records: { session, kind, label, attached, paused, url? }
  close(id?: SessionId): Promise<void>;   // flips to "closing" first (re-entrancy safe)
  closeAll(): Promise<void>;              // shutdown path (index.ts); errors aggregated, not masked
  nextSeq(): number;
}
export const registry = new SessionRegistry();
```

**Startup is atomic by construction — reserve → initialize → activate, with rollback.**
Launch/attach is fallible *after* it has already mutated the world (Chrome can spawn and
then fail waiting for a page or connecting CDP; Node has analogous connect failures), so
the lifecycle functions follow one shape:

```ts
const rec = registry.reserve(kind, label);        // capacity + label enforced here
try {
  // spawn / connect / connectDebugger(rec.state, …) — today's fallible init
  registry.activate(rec.id);
  return { session: rec.id, label: rec.label, /* …payload of §5 */ };
} catch (e) {
  await registry.abort(rec.id);                   // kill partial state, free the slot
  throw e;
}
```

Ordinary tool resolution (`requireSession(id?)` and friends) sees **active records
only** — a half-built session is unobservable, a failed launch never leaves a ghost
record or permanently consumed capacity, and `list_sessions` never shows a session that
can't take a call.

The **accessors keep their names and gain an optional id**, so the ~49 tool-handler read
sites migrate mechanically:

```ts
export function getSession(session?: SessionId): SessionState | null;
export function requireSession(session?: SessionId): SessionState;  // no_session | ambiguous_session | unknown_session
export function requirePaused(session?: SessionId): SessionState;   // + not_paused
```

The `SessionState` class stays un-exported (today only the `Session` type alias and the
singleton escape `state.ts`) — the registry becomes the sole minting path, and the
`Session` alias remains the public type every tool signature already uses.

`requireCapable(s, tool)` already takes the session instance — unchanged, and gating is
automatically per-session (a browser-only tool aimed at `node_1` throws
`unsupported_target` exactly as a single Node session does today).

### Lifecycle and the guards

- The four `alreadySession()` guards become a **per-kind capacity check inside
  `registry.reserve()`**: a second `launch_chrome` while `browser_1` lives (or is still
  starting) throws `already_session` with an amended message naming the live session and
  the v1 one-per-kind rule. (During the staged implementation the capacity check is
  total — size ≥ 1 — preserving today's behavior bit-for-bit until the
  lifecycle-exposure PR flips it to per-kind. §12.)
- `connectDebugger` and the lifecycle functions take the `SessionState` as a parameter
  instead of closing over the singleton import (`connectDebugger(s, client, sessionId)`)
  — a zero-behavior-change threading PR that lands before the registry cutover (§12).
- Shutdown (`index.ts`, both the signal path and SSE close path) calls
  `registry.closeAll()` instead of closing "the" session.
- `close_session` gains the optional `session` param with §2 resolution; `closeSession()`
  keeps its kill-only-if-owned semantics per instance.

### React DevTools bridge state (forward-compatibility with the RDT branch)

The `react-dev-tools-support` branch adds `reactBridge` state. Design rule so the two
branches merge shallowly: **`reactBridge` is an instance field on `SessionState`**, like
every other piece of per-session state — attach is per *browser* session
(`attach_react_devtools` resolves its target via the same `session` param + capability
gate, browser-only), and `close_session` tears it down with the rest of the instance; no
registry-level React state exists. When the branches sync, RDT handlers switch from
`requireSession()` to `requireSession(input.session)` — a one-line change per handler.

## 5. Lifecycle tool surface

- `launch_chrome` / `attach_chrome` / `launch_node` / `attach_node` gain optional
  `label`, and their success payloads gain **`session` + `label`** alongside today's
  fields (today: `{ targetId, url }` for the Chrome pair and `attach_node`;
  `launch_node` adds `pid`, `port`, `inspectMode`, `cwd`, `script`).
- `close_session` today returns plain text (`"closed"` / `"no active session"`); the
  lifecycle-exposure PR upgrades it to `{ session, label, status: "closed" }` so the
  agent sees *which* session it closed — a deliberate behavior change, landing in the
  same PR as the other payload changes. The zero-session case stays an **idempotent
  success** (never `no_session`): `{ session: null, label: null,
  status: "no-active-session" }` — closing nothing is an achieved no-op, matching
  today's `"no active session"` text response.
- **`list_sessions` (new tool)** returns `{ sessions: [{ session, kind, label, attached,
  paused, url? }] }` — the recovery tool that `ambiguous_session` and `unknown_session`
  point at. Callable with zero sessions (returns an empty list, not `no_session`).
- `close_session` takes optional `session` (§2 resolution).
- Tool count 52 → **53** (`list_sessions`, LEO-116) → **54** (`get_timeline`, LEO-365,
  §7); the pinned tool-surface test bumps in the same PR as each registration, via an
  `EXPECTED_TOOL_COUNT` constant (§12 risk note).

## 6. `wait_for_pause` semantics

Today's tool takes a single `timeout_ms` input and returns the `summarizePause` shape
(`reason`, `hit_breakpoint_ids`, `session_id`, `call_stack`). It gains:

- **Scoped (explicit `session`):** wait for *that* session's next pause. The demo
  transcript uses only this form — per-side narration demos better.
- **Raced (omitted `session`, ≥1 live):** wait for *any* session's next pause. The
  return is **locked here**: the full pause summary (today's `summarizePause` shape,
  unchanged) with `session` + `label` prepended — an embedded summary, *not* a pointer
  that would force a scoped follow-up call. This is the one tool where omission with
  two sessions is not `ambiguous_session` — "something is about to pause, tell me
  where" is the natural dual-session idiom, and erroring instead would force agents to
  poll two scoped waits. Note the return then carries **both axes side by side**: the
  new `session` (`"node_1"`) and the existing CDP-child `session_id` (root/worker
  GUID) — the §2 disambiguation table's worked example.
- **Race-loser hygiene:** a raced wait registers a waiter on every live session and must
  cancel the losers when one fires — the `PauseTracker` waiter-cleanup audit is called
  out in the implementing PR (§12). A session closing mid-race removes its waiter; if
  the last session closes, the race rejects with `no_session`.
- **Staging:** raced mode ships in LEO-365. In the interim LEO-116 cut, omitted
  `session` with two sessions returns `ambiguous_session` like every other tool —
  strictly a subset of the final contract, so nothing agent-visible changes semantics
  when raced mode lands; the omitted form goes from erroring to working.

## 7. Buffered reads and the merged timeline (`get_timeline`)

The three existing readers **stay per-session specialized**: `get_console_logs`,
`get_network_requests`, and `get_node_output` gain the `session` param (§2 resolution)
but each still reads exactly one buffer with its own filter inputs (`since`,
`level`/`status`/`stream`, `search`/`url_match`, `limit`) and response schema. No
single existing call can return the browser-network + Node-console interleaving the
full-stack story needs, and a client-side fan-out across three cursors has no clean
completeness contract — so the merged view is a **new tool** (decision recorded on the
PR; supersedes the earlier `session:"all"`-on-the-readers sketch):

```ts
get_timeline({
  session?: SessionId | "all",   // explicit "all" for the dual-target view;
                                 // omitted follows §2 (only live session / ambiguous_session)
  since?: number,
  limit?: number,                // applied AFTER the global merge
  event_types?: Array<"console" | "network" | "node_output">,
}) -> { cursor: number, items: TimelineRow[] }
```

- **Row shape (locked):**

  ```ts
  type TimelineRowBase = {
    seq: number;               // registry-global, the ordering + cursor key
    ts: number;                // ms timestamp, as on every buffer entry today
    session: SessionId;        // debug-target axis
    label: string | null;      // null when the session was launched without one
  };

  type TimelineRow =
    | (TimelineRowBase & { event_type: "console" } & ConsoleItem)      // get_console_logs item fields
    | (TimelineRowBase & { event_type: "network" } & NetworkStartItem) // see below — request-start subset
    | (TimelineRowBase & { event_type: "node_output" } & NodeOutputItem); // get_node_output item fields
  ```

  The `console` and `node_output` variants carry their existing reader's item fields
  with `seq`/`ts` hoisted into the base. The `network` variant is the **request-start
  subset only**: `{ request_id, session_id: string | null, method, url,
  resource_type }` — no `status`/`finished`/`duration_ms` (those mutate later, see
  below). `request_id` + the CDP-child `session_id` are retained precisely so a
  timeline row round-trips into `get_request_body` / `get_response_body`; the
  existing `type` field is surfaced as `resource_type` to avoid colliding with
  `event_type`.
- **Input defaults:** `since` defaults to `0` (start of retained history); `limit`
  defaults to `100`; `event_types` defaults to all three. An **empty `event_types`
  array is `invalid_arg`** — selecting nothing is never intended.
- **Pagination (locked, and deliberately different from the three readers):** rows are
  returned **ascending by `seq` — the earliest rows after `since`, up to `limit`** —
  and `cursor` is the max returned `seq` (`since` echoed back when no rows match).
  The existing readers keep their tail-window semantics (`RingBuffer.query` takes the
  *latest* N via `slice(-limit)`); copying that here would make `since:0, limit:100`
  over seqs 1…1000 return 901…1000 with cursor 1000, silently skipping 900 rows.
  Forward pagination makes polling lossless within retained history — the retention
  bound stays the per-buffer 1000-entry ring cap, exactly as today.
- **Ordering:** a **registry-global monotonic `seq`** — `RingBuffer` seq values are
  allocated from `registry.nextSeq()` instead of each buffer's own counter (today:
  per-buffer, starting at 1). Per-buffer sequences stay monotonic (now sparse, not
  contiguous), so the existing readers' cursor semantics — "cursor is the max seq
  seen" — survive unchanged, and one `get_timeline` cursor spans all buffers.
- **Network rows are request-start events.** A network entry gets its `seq` at
  `Network.requestWillBeSent`; the later response/finished/failed updates mutate that
  entry in the network buffer *without* a new seq, which a `since` cursor that has
  advanced past it would never observe. The timeline therefore treats a network row as
  an immutable snapshot of the request *start* (method, URL, session); current
  status/completion is `get_network_requests`' job. This keeps `since` polling durable
  without re-engineering the network buffer into append-only lifecycle events.
- **Merge contract:** the server gathers the selected buffers across the selected
  sessions, orders by `seq`, then applies `limit` — one coherent global window. Within
  a single window one noisy stream *can* fill the limit (no per-stream fairness policy
  is defined); completeness comes from forward pagination — the next `since: cursor`
  call picks up exactly where the window ended — not from fairness.
- `"all"` is a reserved word in the `session` value space (as is any future `kind:*`
  form); ids are kind-prefixed so no collision is possible.
- `get_timeline` lands in the LEO-365 PR (tool count 53 → **54**, §12).
- This is the **v1 cross-session correlation floor**: the agent sees the browser's
  `fetch("/api/cart")` request-start row and the Node side's console/output rows
  interleaved, and correlates by adjacency + URL. Request-id propagation is explicitly
  future work (§1).

## 8. Capability gating in dual-session mode

No mechanism change. `TOOL_KIND_SUPPORT` (25 browser-only entries, 1 node-only:
`get_node_output`) + `requireCapable(s, tool)` already express per-*instance* gating;
the registry makes the instance vary per call. The `unsupported_target` message grows a
clause: today's `Tool click requires a browser session (current session is node)`
becomes `Tool click requires a browser session (session node_1 is node; the live
browser session is browser_1)` — agent-recoverable without a `list_sessions`
round-trip.

## 9. Source maps, breakpoints, and pause state under two sessions

- **`ScriptStore` is per-instance** with compound keys (`sessionId+scriptId`) *within* a
  session — two live sessions have two stores; a TS file served to the browser and the
  same file compiled for Node never collide.
- **Breakpoints are per-session records**; `set_breakpoint` resolves through the
  targeted session's store only. A file that exists on both sides (shared model code)
  needs two `set_breakpoint` calls, one per `session` — deliberate, and the transcript
  in §11 shows it.
- **Pause state is per-session** (`PauseTracker` instance): both sessions can be paused
  simultaneously — the demo's money shot — and `requirePaused(session)` resolves against
  the targeted session only. Stepping tools operate on their session's pause without
  touching the other's.
- The **entry-pause contract** for `--inspect-brk` (node-session-design.md §7) is
  unchanged and now *scoped*: `launch_node` returning means `node_1`'s entry pause flows
  through `node_1`'s tracker; a concurrent browser session is unaffected.

## 10. Error envelope additions

Same `ToolError` → `{ error, message }` machinery (the single catch in
`src/tools/_register.ts`'s `registerJsonTool`), joining the existing error-code
vocabulary (deliberately not counted here — codes live at their throw sites and a
number would drift); three new codes, one amended:

| Code | When | Message contract |
|---|---|---|
| `ambiguous_session` (new) | `session` omitted, two live sessions, any tool but `wait_for_pause` | Lists every live session as `{ session, kind, label }` and says to pass `session` (or call `list_sessions`) |
| `unknown_session` (new) | Explicit `session` doesn't resolve | Echoes the bad id, lists live sessions the same way — a closed-session id gets recovery, not a bare miss |
| `duplicate_label` (new) | Launch/attach with a label already on a live session (§3) | Names the clashing session; suggests a different label or closing the other side |
| `already_session` (amended) | Per-kind capacity hit (§4) | Names the live same-kind session + the one-per-kind rule |

All three follow the house error-message style: state what happened, echo what the agent
sent, name the recovery move.

## 11. Worked example — the full-stack cart bug

*(Transcript uses the LEO-464 demo app as built — `examples/sample-fullstack-app/`,
dev-build React FE on Vite, Express BE. The bug: `POST /api/cart` answers `200` with
`{"items":[],"count":0}` because `express.json()` is registered after the cart router,
so the handler reads `req.body === undefined` and a defensive guard silently skips the
add. The rehearsed operator version of this transcript is the app's `DEMO.md`.)*

```
launch_chrome  { url: "http://localhost:5173", label: "frontend" }
  → { session: "browser_1", label: "frontend", targetId, url }
launch_node    { script: "examples/sample-fullstack-app/server/dist/index.js",
                 label: "backend" }
  → { session: "node_1", label: "backend", pid, port, ... }   # entry pause per §9
wait_for_pause { session: "node_1" }                     # entry pause reached = the
                                                         # scripts + maps are parsed
set_breakpoint { session: "node_1", file: "server/src/cart.ts", line: 24 }
resume         { session: "node_1" }                     # release entry pause
set_breakpoint { session: "browser_1", file: "src/CartButton.tsx", line: 15 }
click          { session: "browser_1", selector: "#add-espresso" }   # issued as a pair —
wait_for_pause { session: "browser_1" }                  # click settles only on resume
  → paused in CartButton.tsx:15 (handleAddToCart)       # FE side of the story
get_scope      { session: "browser_1", frame_index: 0 } ; resume { session: "browser_1" }
wait_for_pause { session: "node_1" }
  → paused in server/src/cart.ts:24 (POST /api/cart)    # the fetch crossed the wire
get_scope      { session: "node_1", frame_index: 0 }
  → req.body is undefined — body-parser ordering bug exposed
resume         { session: "node_1" }
get_network_requests { session: "browser_1", url_match: "/api/cart" }
  → { cursor: 41, items: [{ request_id: "88.42", session_id: null,
                            status: 200, ... }] }        # metadata only
get_response_body    { session: "browser_1", request_id: "88.42", session_id: null }
  → { request_id: "88.42", base64_encoded: false,
      body: "{\"items\":[],\"count\":0}" }               # symptom confirmed end-to-end
```

Note what the transcript *doesn't* need: no raced waits, no merged timelines, no
`select_session` bookkeeping — with labels in the returns, per-side narration is
self-documenting. (Payloads for the *new* surface — lifecycle returns, pause summaries
with `session`/`label` — are illustrative until their contract tests land; responses
shown for *existing* tools (`get_network_requests`, `get_response_body`) are today's
real envelopes and are not up for reinterpretation.)

### As an L4 eval scenario (sketch — implemented in LEO-365 on the LEO-464 app)

- **Scenario id:** `fullstack-cart` — the first `target: "dual"` scenario (the
  `Scenario.target` discriminator grows a third value alongside `browser` / `node`).
- **Task prompt:** "After clicking add-to-cart the cart badge shows 0 items. Find the
  bug. The frontend dev server is at localhost:5173; the backend entry is
  `examples/sample-fullstack-app/server/dist/index.js`."
- **Oracle checks (deterministic, NDJSON-trace):** (1) two live sessions of different
  kinds existed concurrently; (2) a breakpoint bound in *each* session's coordinate
  space; (3) a pause was observed on the Node side in `server/src/cart.ts`'s handler; (4)
  the final answer names the body-parser ordering (or the `req.body` read) as the root
  cause. Checks 1–3 are structural (tool-call envelopes), check 4 is the usual
  answer-grader — same oracle architecture as today's scenarios, no new grading
  machinery.
- **xfail posture:** starts xfail like other new scenarios until a baseline run
  establishes it's stably passable.

## 12. Implementation mapping (confirms the LEO-116 / LEO-365 boundary)

On the `multi-session-support` branch, squash-merged PRs:

| Branch PR | Ticket | Contents (from this design) |
|---|---|---|
| 1 | LEO-115 | This document |
| 2 | LEO-116 | Thread `SessionState` as a parameter through lifecycle + `debugger.ts` (§4) — zero behavior change |
| 3 | LEO-116 | `SessionRegistry` + accessor cutover + mechanical test migration; guards as total-capacity check (behavior identical); shutdown → `closeAll()` |
| 4 | LEO-116 | First behavior change: per-kind capacity, lifecycle returns `{session, label}`, `list_sessions` (52→53, `EXPECTED_TOOL_COUNT`), `close_session(session?)`, new error codes (§10) |
| 5 | LEO-116 | `session` param across ~45 tools; scoped `wait_for_pause`; `session_id` amendments on all 11 accepting tools — one shared description + schema unification to `.nullable().optional()` + disambiguation table (§2); L2 `session_id:"browser_1"` failure-mode test |
| 6 | LEO-116 | L3 full-stack fixture + `fullstack-flow.e2e.test.ts` (the §11 flow, vanilla-page variant) |
| 7 | LEO-365 | Raced `wait_for_pause` + waiter-cleanup audit (§6); `get_timeline` (53→54, pin bump) + global-seq allocation (§7); L2 contract coverage for the discriminated rows |
| 8 | LEO-365 | L4 cart scenario on the LEO-464 app + docs sweep (README killer flow, ARCHITECTURE lanes, session README) |

Boundary confirmed as ticketed, with one adjustment recorded: the **full-stack L3
fixture sits with LEO-116** (it is the acceptance test of the core refactor and the
demo rehearsal), not LEO-365; LEO-365 keeps raced mode, merged timelines, and the L4
scenario.

Known review risks, owned by the PRs above: the pinned 52-tool set-equality + exact
error strings (every tool-adding PR bumps the pin in-commit); PR 3's test migration must
be assertion-content-neutral (contract tests byte-identical; src cutover and test
migration reviewed as separate commits); two-target CI e2e uses port-0 + close-all-in
after-each + finally-kill for the api-server child.

## 13. Open questions (non-blocking, owned by implementing PRs)

- **Global-seq allocation vs existing L2 assertions** (§7): the global allocation
  itself is locked (`get_timeline`'s ordering depends on it); what's open is only the
  size of the test diff — any contract test pinning *contiguous* per-buffer seq values
  gets relaxed to monotonicity in the LEO-365 PR. The cursor contract survives either
  way.
- **`ambiguous_session` for `evaluate` during dual pause**: when both sessions are
  paused, an omitted-`session` `evaluate` is ambiguous like any other tool — no
  "most-recently-paused" magic. Confirmed here; called out because it is the one place
  a convenience default was tempting and would have been a silent-wrong-target trap.
