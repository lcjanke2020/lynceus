# React DevTools integration — design & spike findings (LEO-209)

> **Implementation status (2026-07-23).** RDT-1 / LEO-359 is implemented by the
> bridge lifecycle in `src/framework/react.ts`; RDT-2 / LEO-360 is implemented by the
> v7 decoder/materialized store (`react-store.ts`), live inspection correlator
> (`react-inspection.ts`), source resolver (`react-source.ts`), and the
> `get_react_tree` / `find_react_component` / `inspect_react_component` tools. The
> implementation follows the reconciled current-snapshot contract in §6.5 #10 while
> preserving this document's empirical spike record.

> Living design doc for the **LEO-209** spike: embedding `react-devtools-core` behind a `FrameworkAdapter` seam in lynceus (Depth 2). It is built up incrementally across the sub-spikes S0–S6; **S6 (LEO-217) is the synthesis pass** that folds these findings into the final layer design and the reshaped LEO-9X.2–.7 proposals. Companion to [`docs/design-notes.md`](./design-notes.md) (v1, browser-only) and [`docs/node-session-design.md`](./node-session-design.md) (the Node extension).
>
> The architecture-level decisions locked in LEO-209 — **Depth 2** (embed `react-devtools-core`), the **`FrameworkAdapter` seam** (`src/framework/adapter.ts`; the stateless React-only resolver landed in RDT-1 PR 1a, with bridge lifecycle deferred to PR 1b), and the **in-band CDP transport** (`Runtime.addBinding({name:"__lynceusReact__"})` + `Page.addScriptToEvaluateOnNewDocument`) — are **inputs** here, not re-litigated. This doc records what the surveys/spikes discover *about* those decisions.
>
> **How to read this doc:** §1 (architecture seed), §2 (S2/LEO-213 bridge round-trip), §3 (S3/LEO-214 lifecycle & event model), §4 (S4/LEO-215 cross-version matrix + prod-build detection), §5 (S5/LEO-216 surveys) and §6 (S6/LEO-217 synthesis) have all landed; each section is self-contained. **§6 is the synthesis pass** — it validates/revises the layer design, resolves the outstanding LEO-209 open questions, and reshapes the LEO-9X.2–.7 follow-on proposals. A `—` status below means "not landed yet."

> **Port note (LEO-465, 2026-07-18).** This document was authored on the archived pre-rename
> (cdp-mcp era) repository across spikes S2–S6 and ported here as PR 0 of the
> `react-dev-tools-support` branch, with page-global and package naming updated to lynceus per
> LEO-359's locked naming: `__lynceusReact__` (binding), `__lynceusReactDispatch__` (reverse
> dispatcher), `__LYNCEUS_BRIDGE_BOOTSTRAP__` (bootstrap skip-flag). The spike artifacts it
> references (`spikes/react-devtools/`, branch `agents/react-devtools-spike`) live only on the
> archived pre-rename repo — re-implement in `src/` per §3.10; that branch does not exist here.
>
> **Version pins.** Vendored backend / ABI anchor: **`react-devtools-core@7.0.1`** (§6.2 #1;
> all `dist/backend.js` line cites are against this bundle). Verified React matrix: the S2
> bridge recipe was proven on **18.3.1** (the LEO-213 gate); the S4 matrix verified **16.8.0 /
> 16.14.0 / 17.0.2 / 18.3.1 (dev + prod) / 19.1.0** → v1 support floor React 16.8–19 (§4.5).
>
> **Drift vs the LEO-213 gate comment (for RDT-1).** Cross-checked at port time; this doc is
> the corrected authority on two points where the gate comment has drifted: (1) the `source`
> tuple points at the component's **definition site**, not the "actual call site" the gate
> comment described (S3-confirmed; §2.5, §3.4); (2) the gate comment's "no new source-map
> plumbing needed" undersells it — a `url → candidates` reverse index is a genuinely new piece,
> `sessionId` must be threaded through, and the real signature is
> `mapCdpToOriginal(store, frame, sessionId)` (§2.5). Everything else (bootstrap ordering,
> setter-on-`ReactDevToolsBackend`, single-object listener, sentinel readiness,
> hook-stub-skip) matches the gate comment.
>
> The PR #66 review rounds (Codex / Fable / Kimi / Copilot, 2026-07-18) tightened §1, §2.1,
> §2.5, §2.6, §3.2, §4.1, §4.3, §5.3, §6.1–§6.3 and logged four new reconciliation rows
> (§6.5 #7–10); the spike findings themselves are unchanged from the original.

## Document status — contributing spikes

| Spike | Ticket | Contributes | Status |
|---|---|---|---|
| S0 | LEO-218 | execution-order tracker + gate decisions | — |
| S1 | (harness bootstrap) | scratch worktree + minimal React pages | — |
| S2 | LEO-213 | bridge round-trip: transport wiring, `operations`/`inspectElement`, source-map (§2) | ✅ §2 (gate: GO) |
| S3 | LEO-214 | bridge lifecycle & event model: navigation survival, delta-vs-snapshot, source edge cases (§3) | ✅ §3 |
| S4 | LEO-215 | cross-version matrix (16/17/18/19) + prod-build detection; reuses the S3 enriched fixture (§4) | ✅ §4 |
| **S5** | **LEO-216** | **OSS prior-art audit · React bug taxonomy · two L4 scenario sketches · overrides-via-bridge feasibility** | **✅ this section (§5)** |
| S6 | LEO-217 | design-doc synthesis + reshaped LEO-9X.2–.7 proposals | ✅ §6 |

*The table lists every sub-spike S0–S6 for completeness; `—` = nothing landed yet. S2 was the GO gate **and** contributes §2.*

---

# §1 — Architecture (5-layer seed from LEO-209)

Provisional structure to be validated/revised by the spike.

- **Layer 0 — `FrameworkAdapter` seam.** `src/framework/adapter.ts`; tool layer dispatches by framework; only `react` resolves in v1. Mirrors the eval harness's `VendorAdapter` seam (`evals/harness/vendor.ts`).
- **Layer 1 — Backend injection.** `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding({name: "__lynceusReact__"})`, with the binding wired directly into `react-devtools-core`'s `connectWithCustomMessagingProtocol({onSubscribe, onUnsubscribe, onMessage})` — **no hand-rolled Wall needed** (this seed originally proposed a "custom Wall"; §2.1/§2.2 supersede that — the protocol callbacks *are* the Wall). `Page.reload()` after `addScriptToEvaluateOnNewDocument` for already-loaded pages.
- **Layer 2 — Per-session state.** `reactBridge` field on `SessionState` (cleared on `reset()`; generation counter mirroring LEO-120's `ownedProcessGeneration`); `ReactBridgeEvent` in `buffers.ts`; reused `RingBuffer<T>`.
- **Layer 3 — Tools.** 8 core MCP tools (+ 2 stretch) in `src/tools/react.ts`: `attach_react_devtools` / `detach_react_devtools` / `get_react_tree` / `inspect_react_component` / `find_react_component` / `start_react_profiling` / `stop_react_profiling` / `get_react_profile`; **stretch:** `override_react_props` / `override_react_hook_state`.
- **Layer 4 — Capability gating.** Browser-only via `TOOL_KIND_SUPPORT`; new `requireReactBridge(s)` guard modeled on `requirePaused()`.

---

# §2 — S2 findings (LEO-213, bridge round-trip)

## 2.1 react-devtools-core v7 public API

The v7 backend bundle (`dist/backend.js`, 622 KB UMD, MIT) exposes the following on the global `ReactDevToolsBackend`:

| Function | Purpose | Useful for |
|---|---|---|
| `initialize(settings)` | Installs the bundle's rich hook (calls `installHook(window, …)`) and patches `console` / default appearance settings. | **Mandatory in this architecture** — call before `connectWithCustomMessagingProtocol` (§2.2 step 4): the bootstrap makes the page's inline hook stub skip itself, so skipping `initialize()` leaves no rich hook for React to inject into. Only the *settings* aspect is ignorable in v1. |
| `connectToDevTools(opts)` | Opens a WebSocket to a frontend on `host:port` (default `localhost:8097`). | Not what we want — it's WebSocket-bound. |
| `connectWithCustomMessagingProtocol({onSubscribe, onUnsubscribe, onMessage})` | Takes a custom messaging protocol via callbacks; returns an unsubscribe function. | **This is the Wall abstraction we want.** |

`connectWithCustomMessagingProtocol` is the path the README explicitly documents as the alternative to `connectToDevTools` for non-WebSocket transports. The callback shape:

- `onSubscribe(listener)` — backend registers a listener; we save the reference so the adapter can push messages to it.
- `onUnsubscribe(listener)` — backend unregisters. We clear the saved reference.
- `onMessage(event, payload)` — backend wants to send an `(event, payload)` pair to the frontend. We forward via the CDP binding.

No need to write a custom Wall — `connectWithCustomMessagingProtocol` *is* the Wall in protocol form.

## 2.2 Transport wiring

The bootstrap injected via `Page.addScriptToEvaluateOnNewDocument` has to do four things in this order (verified by reading `dist/backend.js`). All `dist/backend.js` line numbers in §2.2–§2.3 cite the vendored **`react-devtools-core@7.0.1`** bundle and will drift with the package version — the surrounding symbol names are the durable anchor (same discipline as the Appendix's facebook/react cites):

1. Set `window.__LYNCEUS_BRIDGE_BOOTSTRAP__ = true` so the page's S1-style inline hook stub skips itself. `installHook` (bundle line 14694) early-returns if `target.hasOwnProperty('__REACT_DEVTOOLS_GLOBAL_HOOK__')` — so any pre-installed hook (even ours) **blocks the rich hook** the bundle wants to install.
2. Install `window.__lynceusReactDispatch__` as the reverse-channel entry point. Its body calls `backendListener({event, payload})` — **as a single message object, not positional args**. The Bridge's `wall.listen(fn)` handler does `if (message && message.event) emit(message.event, message.payload)` (bundle line 5392).
3. Define `Object.defineProperty(window, 'ReactDevToolsBackend', { set })` so the UMD's `root["ReactDevToolsBackend"] = factory()` assignment **synchronously** triggers attach BEFORE the next `<script src="react@18...">` tag executes. Polling for the property works too but races commits.
4. Inside the setter: call `backend.initialize()` first (this is what calls `installHook(window, ...)`), then `backend.connectWithCustomMessagingProtocol({onSubscribe, onUnsubscribe, onMessage})`.

Forward channel: backend → adapter via `Runtime.addBinding({name: "__lynceusReact__"})` + `Runtime.bindingCalled`. The bootstrap's `onMessage(event, payload)` callback `window.__lynceusReact__(JSON.stringify({event, payload}))`.

Reverse channel: adapter → backend via `Runtime.evaluate({expression: 'window.__lynceusReactDispatch__("event", payload)'})`. The dispatcher invokes the listener the backend handed us in `onSubscribe`.

## 2.3 Operations event — backend → adapter

Verified end-to-end against `react@18.3.1` mounting a `<Counter label="apples">` + `<Counter label="oranges">` tree. **`operations` event arrives** as soon as the first commit lands. Cycle is:
- React renderer calls `hook.inject(renderer)` (after `initialize()` has installed the rich hook).
- Rich hook's `inject` runs `attach(hook, id, renderer, global)` (bundle line 6586), builds a `rendererInterface`, adds it to `hook.rendererInterfaces`, emits `'renderer-attached'`.
- `initBackend` (called inside `connectWithCustomMessagingProtocol`) is subscribed to `'renderer-attached'`. It wires `rendererInterface` to the agent.
- React commits → `hook.onCommitFiberRoot` (which the rendererInterface replaced) walks the fiber tree, emits `'operations'` on the hook, which the agent forwards via `onMessage('operations', payload)`.

Pre-attach events that flow through the forward channel during handshake (informational, not gate criteria): `backendInitialized`, `overrideComponentFilters`, `isReloadAndProfileSupportedByBackend`.

## 2.4 inspectElement — adapter → backend → adapter

Verified end-to-end. Send shape:
```js
window.__lynceusReactDispatch__("inspectElement", {
  id: <componentId>,
  path: null,
  rendererID: 1,
  forceFullData: true,
});
```

Reply event name is **`inspectedElement`** (past-tense; not `inspectElement`). Reply payload shape (truncated; full struct has ~30 fields):
```js
{
  id: <componentId>,
  type: "full-data",          // or "no-change", "not-found", "error"
  value: {
    id: <componentId>,
    type: <fiberType>,        // 5 = function component invocation, 11 = root...
    displayName: <string|null>,
    source: [<componentName>, <scriptUrl>, <line>, <col>] | null,
    props: { ... },
    state: { ... },
    hooks: [ ... ],
    context: { ... },
    plugins: { stylex: null, ... },
    canEditFunctionProps: <bool>,
    canEditHooks: <bool>,
    errors: [], warnings: [],
    rendererPackageName: <string|null>,
    rendererVersion: <string|null>,
    // ...
  }
}
```

## 2.5 Source-map round-trip (`source` → TS file:line:col)

**Three findings that change the plan from LEO-209's framing:**

(1) The `source` field shape is **a tuple `[componentName, scriptUrl, line, col]`**, NOT the `{fileName, lineNumber, columnNumber}` object older React DevTools docs describe. Pulling out the URL + line + col is mechanically straightforward.

(2) **React 18.3.1's source-attribution is runtime stack-based, not `__source` props.** We tested a page that explicitly set `__source: {fileName, lineNumber, columnNumber}` on every `React.createElement` call (simulating `@babel/plugin-transform-react-jsx-source`). The reported `source` for inspected Counter instances was `["Counter", "http://127.0.0.1:8765/react18-jsx.html", 49, 24]` — line 49 is the `function Counter(...)` **definition site**, not the `__source` we passed (nor the `createElement` call sites). So the babel `jsx-source` plugin is **no longer a prerequisite** for source positions; React derives them from the component function's runtime definition location. (S3/§3.4 characterizes this precisely across wrapper types and confirms the "definition site" wording.) **Scope:** this is a **development-build** result — production React builds may strip or alter source attribution, and pre-18 React may still depend on `__source`; do not assume it holds everywhere.

(3) **Source-map plumbing is nearly free — one small addition.** The `scriptUrl` is a live URL (the served HTML in our spike; in a real Vite/webpack app it'd be the bundled JS URL). lynceus's existing `src/sourcemap/store.ts` already tracks `Debugger.scriptParsed` and maps a CDP frame → original TS via the **free function** `mapCdpToOriginal(store, frame, sessionId)`, where `frame` is `{scriptId, lineNumber, columnNumber}`. Two things the round-trip must respect: **(a)** there is **no URL→scriptId reverse lookup today** — `ScriptStore` is keyed by `(sessionId, scriptId)` and exposes `get()` / `all()`; a small `url → candidates` index over `ScriptInfo.url` is the one genuinely new piece to add (URL alone is **not** unique — inline scripts share the document URL and the same bundle URL can load in multiple realms — so matches must be disambiguated by the originating session/execution context). **(b)** scripts are **per flat session**, so the matched script's `sessionId` must be threaded through, or an iframe/worker script routes through the wrong Debugger agent (per the AGENTS.md session-ID rule). Sketch against the real API:
```ts
function reactSourceToOriginal(store: ScriptStore, source: [string, string, number, number]) {
  const [, scriptUrl, line, col] = source;
  const script = store.all().find((s) => s.url === scriptUrl); // real impl: url → candidates index, disambiguated by session/execution context (URLs are not unique)
  if (!script) return null;
  // React `source` line AND column are 1-based (§4.2: `function X() {` declarations at 2-space
  // indent report col 3). mapCdpToOriginal expects 0-based CDP coordinates — it re-adds 1 to the
  // line only for the source-map lookup (see `mapCdpToOriginal` in store.ts) — so decrement both.
  return mapCdpToOriginal(store, { scriptId: script.scriptId, lineNumber: line - 1, columnNumber: col - 1 }, script.sessionId);
}
```
So the conclusion (round-trip feasible via existing machinery) holds — but the url → candidates index is a small new piece, not zero, and `sessionId` must be preserved.

**Follow-up (resolved in S3/§3.4):** what `source` do fragments, memo/forwardRef wrappers, and Suspense boundaries report? S3 answered this — `source` is present for memo/forwardRef (pointing at the inner fn) and `null` for the root, `Context.Provider`/`Suspense` boundary fibers, and createRoot-owned structural components (App, Layout, Header, Main). See §3.4.

## 2.6 Gate decision

**GO.** The Depth 2 architecture works end-to-end on React 18.3.1:
- ✅ `Runtime.addBinding` + `Page.addScriptToEvaluateOnNewDocument` deliver pre-React execution.
- ✅ `backend.initialize()` + `backend.connectWithCustomMessagingProtocol({...})` wire the bridge with a public API — no internal patching, no monkey-patching, no WebSocket fallback needed.
- ✅ `operations` event (backend → adapter) received on first commit.
- ✅ `inspectedElement` event (adapter → backend → adapter) returns rich props/state/hooks/source.
- ✅ Source-map round-trip is mechanically feasible via existing lynceus machinery.

**No pivot to the WebSocket-on-localhost contingency.** S3 (LEO-214) now proceeds as planned: characterize lifecycle behavior (nav survival + delta vs snapshot tree events) under this same architecture.

**Evidence:** `spikes/react-devtools/s2/bridge.mjs` smoke output (commit on the archived pre-rename repo's `agents/react-devtools-spike` branch):
```
attached: true
operationsCount: 1
inspectedReply.value.type: 11 (root)
otherEventNames: overrideComponentFilters, backendInitialized, isReloadAndProfileSupportedByBackend
spikeErrors: []
---- GATE: PASS ----
```

## 2.7 Reusable artifacts S3+ can build on

- `s2/bootstrap.js` — pre-React injection that wires the bridge. S3 will reuse this verbatim and exercise it across navigations.
- `s2/bridge.mjs` — the Node-side adapter. S3 can extend it to drive `Page.frameNavigated` lifecycle, S4 to drive across versions.
- Pages `pages/react18-jsx.html` — JSX-shaped page (with `__source` props that turn out to be ignored, but the page itself is a clean React 18 fixture).
- Hook-stub-skip pattern: `if (!window.__LYNCEUS_BRIDGE_BOOTSTRAP__) { ... }` in any page wanting to coexist with the bridge bootstrap.

---

# §3 — S3 findings (LEO-214, lifecycle & event model)

S3 reuses the S2 bridge recipe unchanged and exercises it across navigations and
re-render churn against a new **enriched fixture** with known ground truth
(`spikes/react-devtools/pages/enriched.fixture.js`, ground truth in
`fixtures/GROUND_TRUTH.md`). All measurements below are empirical — React **18.3.1**,
`react-devtools-core@7.0.1` backend, driven headless via Playwright's chromium 149 under
CDP. Probes: `s2/probe-operations.mjs` (operations stream), `s2/probe-inspect.mjs`
(inspectElement), sharing `s2/harness.mjs`; opcode decoder `s2/operations-decode.mjs`
mirrors the backend's own decoder.

**Bottom line: no pivot.** None of the Pivot-1 brittleness thresholds tripped (§3.5).
The binding survives every navigation type tested; the operations stream is a delta/patch
stream exactly as §5.1 predicted; the internal accumulation model is settled. The original
spike described a cursor-based public read, but LEO-466 later superseded that API choice with
a current server-materialized snapshot (§6.3). S4 (LEO-215) can reuse this harness as-is.

## 3.1 Navigation-survival matrix (task a)

The CDP transport is **two** persistent registrations: `Runtime.addBinding({name})` and
`Page.addScriptToEvaluateOnNewDocument(bootstrap)`. We navigate WITHOUT re-adding either,
then check (a) whether a fresh backend re-attaches, (b) whether `window.__lynceusReact__`
(the binding) is still callable, and (c) whether an `inspectElement` round-trip still works.

| Navigation | fresh re-attach? | binding present? | inspect round-trips? | transport intact? |
|---|---|---|---|---|
| same-origin nav (`/react18.html`) | ✅ yes | ✅ | ✅ | ✅ |
| **cross-origin nav** (`127.0.0.1`→`127.0.0.2`, different site) | ✅ yes | ✅ | ✅ | ✅ |
| back (history) | ❌ no (bfcache) | ✅ | ✅ | ✅ |
| forward (history) | ❌ no (bfcache) | ✅ | ✅ | ✅ |
| hard reload (`ignoreCache`) | ✅ yes | ✅ | ✅ | ✅ |

**The binding + injected bootstrap survive ALL navigation types**, including the
cross-origin case that §5.1/the ticket flagged as the most likely breaker. Both
`addScriptToEvaluateOnNewDocument` and `addBinding` are registered on the **page target**,
not on an origin or a single execution context, so they persist across origin changes by
construction. (The cross-origin case navigated `127.0.0.1` → `127.0.0.2` — distinct sites,
both loopback; a true cross-site navigation exercises the same per-target mechanism, so the
result generalizes.) Two regimes:

- **New-document navigations** (same-origin, cross-origin, hard reload): the browser tears
  down the document, `addScriptToEvaluateOnNewDocument` re-runs the bootstrap on the new
  document, and a **fresh backend instance re-attaches automatically** (a new
  `renderer-attached`, a new mount `operations`). Cost is low: cross-origin re-attach
  ~220 ms, hard-reload ~290 ms (dominated by React re-download + first commit).
- **History back/forward**: restored from the **bfcache** — no new document, so the
  bootstrap does *not* re-run and there is no fresh mount `operations`. But the previously
  attached backend is restored intact: the binding is still callable and `inspectElement`
  still round-trips. So "no re-attach" here is *correct*, not a failure — nothing to
  re-attach.

**Reattach protocol (implication for Layer 2).** No protocol is needed to *keep the
binding alive* — CDP handles that. What IS needed is **generation handling on new-document
navigations**: each such nav produces a *new backend instance and a fresh element-ID
space*, so the accumulated store state (element-ID → node maps, string tables) must be
**reset per new-document navigation**, keyed off a generation counter (the LEO-120
`ownedProcessGeneration` mirror already in the Layer-2 seed is the right shape). Trigger the
reset off the **loader ID changing** on `Page.frameNavigated` (equivalently, the fresh
`renderer-attached` / mount `operations`) — **not** the bare event: some Chrome versions
still emit `Page.frameNavigated` on a bfcache restore, and keying off the event alone would
wrongly wipe state on back/forward. bfcache restores keep the same loader ⇒ same generation
⇒ no reset. This confirms §5.1's "reset maps/string-tables per navigation" empirically and
refines it: reset per *new-document* nav (loader change), not per history nav.

**Pivot-2 (auto-attach) does not trigger.** Reattach is automatic and cheap and nav-loss
is neither silent nor frequent (the binding never actually drops), so manual
`attach_react_devtools` remains viable. Do not remove the opt-in attach tool.

## 3.2 Tree-event model — delta stream confirmed; public snapshot contract supersedes

`operations` is a **patch stream**, decisively:

| event | `operations` messages | array size | opcodes |
|---|---|---|---|
| initial mount | 1 | 271 ints | 15 `ADD` + 1 `SUSPENSE_ADD` |
| `increment()` — pure state change | **0** | — | — |
| `addTodo()` — mount one node | 1 | 46 ints | `ADD` + `REORDER_CHILDREN` + `SUSPENSE_RESIZE` |
| `reorderTodos()` — reverse list | 1 | 10 ints | `REORDER_CHILDREN` |

Mount is one big batch of `ADD`s; every subsequent **structural** change is a tiny
incremental patch. This forces the server to accumulate operations into materialized store
state; there is no backend "give me the whole tree" pull. The spike originally inferred a
cursor-based public API from that transport shape. **LEO-466 supersedes that public-contract
inference:** `get_react_tree` returns the current server-materialized snapshot, and agents do
not consume cursors or reconstruct the tree from deltas. The empirical delta-stream finding
remains the internal implementation constraint.

**Operations format (v7), mirrored in `operations-decode.mjs`:** header
`[rendererID, rootID, stringTableSize, …stringTable…]` then opcodes. **Two interleaved
opcode families** share one array: the component tree (`ADD=1, REMOVE=2, REORDER_CHILDREN=3,
UPDATE_TREE_BASE_DURATION=4, UPDATE_ERRORS_OR_WARNINGS=5, REMOVE_ROOT=6, SET_SUBTREE_MODE=7`)
and a v7 **suspense tree** (`SUSPENSE_ADD=8, SUSPENSE_REMOVE=9, SUSPENSE_REORDER_CHILDREN=10,
SUSPENSE_RESIZE=11, SUSPENSE_SUSPENDERS=12`; names as in §3.9's reference table). Gotchas
for whoever lifts the decoder (LEO-360/RDT-2): the non-root `ADD` carries **five** fields
*after* `id`/`type` (`parentID, ownerID, displayNameStringID, keyStringID, namePropStringID`
— the 5th is easy to miss and desyncs the whole walk; see the full operand order in §3.9),
and a `SUSPENSE_RESIZE` rides along even for
fixtures with no explicit `<Suspense>`. Host DOM nodes never appear (default
`ElementTypeHostComponent` filter).

## 3.3 Structure is pushed; values are pulled (dehydrated)

The single most consequential finding for the tool surface: **`operations` carries only
structural tree mutations, never value changes.** A pure state update (and 60 re-renders/s
of churn, §3.5) emit **zero** `operations`. So component props/state/hooks/context are
**not streamed** — they are **pulled on demand** via `inspectElement`, whose reply
**dehydrates** large values into an envelope `{ data, cleaned, unserializable }`:
functions → `{inspectable:false, preview_short:"() => {}", type:"function"}`, nested
objects → `{inspectable:true, type:"object", preview_long:"{fontScale: 1}", size:1}`, with
a `cleaned` list of paths for **lazy hydration** (a follow-up `inspectElement` with a
`path`). Design consequence:

- `SessionState.reactBridge` accumulates the (sparse, structural) `operations` stream into
  a tree + element-ID maps; `RingBuffer<ReactBridgeEvent>` buffers **operations messages**,
  which are infrequent (0 on pure re-render). Buffer pressure is low.
- `get_react_tree` reads accumulated structure (ids, displayNames, parent/child, keys).
- `inspect_react_component` does a live `inspectElement` pull and must **handle the
  dehydrated envelope + path hydration**, not assume plain values.

## 3.4 `source` under wrappers (task c) — resolves the §2.5 follow-up

Inspecting every node of a fragments/memo/forwardRef/Suspense fixture
(`pages/source-edge.fixture.js`):

| construct | `source` reported? | points at |
|---|---|---|
| `React.memo(Inner)` | ✅ yes | the **inner** component's definition (`MemoInner`) |
| `React.forwardRef(Inner)` | ✅ yes | the **inner** render fn (`ForwardInner`) |
| `React.lazy` child under `<Suspense>` | ✅ yes | the lazy component itself (`Panel`) |
| `<Suspense>` boundary fiber | ❌ null | — |
| `Context.Provider` fiber | ❌ null | — |
| root, and createRoot-owned / purely-structural components (App, Layout, Header, Main) | ❌ null | — |

So the S2 parked `source: null` generalizes: it is **not just the root**. `source` is the
runtime **function-definition** site and is `null` for (i) the root, (ii) wrapper/boundary
fibers that have no user function of their own (`Context.Provider`, `Suspense`), and (iii)
a class of top/structural components. `memo`/`forwardRef` do **not** lose source — they
report the wrapped function. Confirms S2: `source` is runtime stack-based; **no `__source`
prop was passed** and coordinates were still reported. `find_react_component`/source-map
tools must tolerate `source: null` on a meaningful minority of nodes and fall back to
displayName/tree-position.

## 3.5 Hooks & bridge-mandatory context (L4 grounding)

`inspectElement` returns the full hooks tree (dehydrated). A **custom hook** appears as a
named node with its internals as `subHooks`: `StaleCounter` →
`State(0)`, `DocumentTitle{ State("clicks: 0"), Effect }`, `Effect × 3`. Deep context is
readable: `ThemeBadge`'s two `useContext` hooks return the live values
`{theme:"light"}` and `{settings:{fontScale:1}}` — data **knowable only via the bridge**,
not from source. This concretely grounds the L4 `react-provider-context` scenario
(LEO-361): the provider sits several levels above the consumer; only the bridge recovers
the resolved value. The deliberate stale-closure bug is likewise reproduced
(`liveCount=6` while the buggy interval's `staleObserved=0`) as the source-solvable control.

## 3.6 Pivot-1 measurements (none tripped)

| criterion | threshold | measured | tripped? |
|---|---|---|---|
| (i) binding lost on same-origin nav | any loss | survived; transport intact | **no** |
| (ii) operations dropped/garbled at 60 msg/s churn | >1% | 235 structural msgs @ ~59/s, **0 drops, 0 parse errors** (0.000%) | **no** |
| (iii) 3 consecutive attach failures on healthy fixture | 3 in a row | 3/3 attaches **passed** | **no** |

On (ii): pure re-render churn is a *weak* transport test because re-renders emit no
`operations` (§3.3); we therefore also ran **structural** churn (alternating add/remove at
60/s) to actually load the binding — 235 messages at ~59 msg/s delivered with **zero** seq
gaps and zero garbling. Sequence-number contiguity is checked per document epoch (the
bootstrap tags every forward message with a monotonic `seq`); the only gaps observed
(≈1/navigation) are epoch-reset races at nav boundaries, not steady-state drops. The
`Runtime.addBinding` → `Runtime.bindingCalled` channel is reliable at this rate. **No halt;
no WebSocket-on-localhost pivot.**

## 3.7 Injection ordering (measured, not inferred)

`performance.now()` marks in the bootstrap (added for S3) confirm the ordering the S2 gate
inferred: bootstrap entry ~9 ms → `backend.initialize()` ~38 ms → `connectWithCustom…`
~40 ms, all **before** React's first `hook.inject()` at ~290 ms (renderer registration,
instrumented via a wrapped `hook.inject`). The setter-on-`ReactDevToolsBackend` attach
fires ~30 ms after bootstrap, comfortably ahead of React — the pre-React injection
guarantee holds with headroom.

## 3.8 Net effect on the layer design (§1)

- **Layer 2** — `reactBridge` accumulates the structural `operations` stream; reset its
  maps/string-tables on **new-document** navigations via the generation counter; bfcache
  restores need no reset. Buffer is low-pressure (structural events only).
- **Layer 3** — `get_react_tree` returns the current server-materialized snapshot (LEO-466);
  the server alone applies the accumulated delta stream;
  `inspect_react_component` pulls live and must decode the dehydrated `{data, cleaned}`
  envelope with path hydration; source-dependent tools tolerate `source: null`.
- **No architecture change; no pivot.** S4 (LEO-215) reuses this harness for the
  16/17/18/19 matrix (fixture already parameterized by version; enriched React-19 page
  present).

## 3.9 Reference — `operations` wire format (v7)

Durable spec for `react-devtools-core@7.0.1` (mirrored in the spike's
`operations-decode.mjs`; source of truth is that bundle's own decoder, `dist/backend.js`
≈ L2884–3058 — *line numbers drift with the package version; the symbol/opcode names are
the durable anchor*). Captured here so RDT-2/LEO-360 doesn't re-derive it if the throwaway
spike branch is pruned — and it stays re-verifiable against the **immutable published
`react-devtools-core@7.0.1` on npm** even after the branch is gone. An `operations` payload
is a flat `Array<number>`:

```
[ rendererID, rootID, stringTableSize, …string table…, …opcodes… ]
```

`rootID` is normally the positive commit root. The v7 Fiber renderer uses `-1` for
renderer-wide batches flushed outside a root commit, notably bulk error/warning
updates; a decoder must accept that sentinel while still requiring a concrete root
for root/component ADD and `REMOVE_ROOT`.

**String table** — `stringTableSize` is the number of **ints** the table occupies (not the
string count); those ints encode consecutive length-prefixed strings, `[len, codePoint ×
len]` each (1-indexed; index 0 = null).

**Two interleaved opcode families share one array.** Component-tree ops (1–7) and v7
suspense-tree ops (8–12). Operands are listed in array order, *after* the opcode int:

| # | opcode | operands (in order) |
|---|---|---|
| 1 | `ADD` (root, type=11) | `id, type, isStrictModeCompiled, profilingFlags, supportsStrictMode, hasOwnerMetadata` |
| 1 | `ADD` (non-root) | `id, type, parentID, ownerID, displayNameStringID, keyStringID, namePropStringID` (7 operands; `namePropStringID` is the easy-to-miss 5th field after id/type) |
| 2 | `REMOVE` | `removeLength, id × removeLength` |
| 3 | `REORDER_CHILDREN` | `id, numChildren, childID × numChildren` |
| 4 | `UPDATE_TREE_BASE_DURATION` | `id, duration` |
| 5 | `UPDATE_ERRORS_OR_WARNINGS` | `id, numErrors, numWarnings` |
| 6 | `REMOVE_ROOT` | *(none)* |
| 7 | `SET_SUBTREE_MODE` | `id, mode` |
| 8 | `SUSPENSE_ADD` | `fiberID, parentID, nameStringID, isSuspended, numRects, (x,y,w,h) × numRects` |
| 9 | `SUSPENSE_REMOVE` | `removeLength, id × removeLength` |
| 10 | `SUSPENSE_REORDER_CHILDREN` | `id, numChildren, childID × numChildren` |
| 11 | `SUSPENSE_RESIZE` | `id, numRects, (x,y,w,h) × numRects` (numRects `-1` ⇒ null, no rects) |
| 12 | `SUSPENSE_SUSPENDERS` | `changeLength, [id, hasUniqueSuspenders, isSuspended, envLen, envID × envLen] × changeLength` |

Gotchas that desync a naive walker: (1) the **non-root `ADD` carries FIVE fields** — the
5th, `namePropStringID` (non-null only for `Suspense`/`Activity`), is easy to miss; (2) a
`SUSPENSE_RESIZE` rides along on ordinary commits even with no explicit `<Suspense>`; (3)
**host DOM nodes never appear** — the default `ElementTypeHostComponent` component filter
strips them, so `operations` only ever carries composite components + provider/boundary
fibers. `ElementType`s seen: `2` Context (provider fibers), `5` Function, `6` ForwardRef,
`8` Memo, `11` Root, `12` Suspense.

## 3.10 S3 spike artifacts — what to lift

All on the archived pre-rename repo's `agents/react-devtools-spike` branch (`spikes/react-devtools/`, never merges — re-implement
in `src/` under the follow-on tickets). Index so future work knows what exists:

| Artifact | Purpose | Lift target |
|---|---|---|
| `pages/enriched.fixture.js` + `fixtures/GROUND_TRUTH.md` | version-agnostic enriched fixture with documented ground truth (hooks, providers, list, stale-closure) | S4 (LEO-215) degradation-by-diff; eval fixtures |
| `pages/source-edge.fixture.js` | fragments / memo / forwardRef / Suspense source characterization | §3.4 evidence; RDT source tool tests |
| `s2/bootstrap.js` | pre-React injection recipe (setter-on-`ReactDevToolsBackend`, hook-skip flag, reverse dispatcher) + `performance.now()` marks + forward `seq` | Layer 1 backend injection |
| `s2/harness.mjs` | Node CDP transport: server(s), chromium launch, `addBinding`, bootstrap inject, per-epoch seq/gap tracking, nav/dispatch/inspect helpers | Layer 1/2 bridge adapter |
| `s2/operations-decode.mjs` | authoritative v7 `operations` decoder (§3.9) | **RDT-2 / LEO-360** `get_react_tree` |
| `s2/probe-operations.mjs` | nav-survival matrix, delta-vs-snapshot, re-render + structural churn | S4 lifecycle re-runs |
| `s2/probe-inspect.mjs` | `inspectElement` source + hooks walk (handles the dehydrated `{data,cleaned}` envelope) | RDT `inspect_react_component` |

---

# §4 — S4 findings (LEO-215, cross-version matrix)

S4 characterizes the biggest known risk flagged for LEO-209 — **Fiber ABI version
coupling** — by replaying the S3 round-trip against **React 16 / 17 / 18 / 19** and a React
**production** build. The mandate is to hunt for *silent partial* failure (incomplete
trees, missing props, stripped values) that hard-error detection would miss, and to
recommend a v1 support floor. Method: the S3 harness unchanged, one shared enriched fixture
(`pages/enriched.fixture.js`, ground truth `fixtures/GROUND_TRUTH.md`) driven per version
via a new `S4_PAGE` parameter on `s2/probe-operations.mjs` + `s2/probe-inspect.mjs`;
`react-devtools-core@7.0.1` backend; headless chromium 149 under CDP. Versions:
`react@16.8.0` / `16.14.0` / `17.0.2` (UMD, legacy `ReactDOM.render`), `18.3.1` (UMD,
`createRoot`), `19.1.0` (ESM, `createRoot`); prod =
`react-dom@18.3.1/umd/react-dom.production.min.js`. (`16.8.0` is a round-2 spot-check of the
floor's lower bound — the first hooks release; see §4.5.)
Probes/pages on the archived pre-rename repo's `agents/react-devtools-spike` branch (never merges).

**Bottom line: no pivot, and the floor is *wider* than the ticket's straw-man `18+`.** All
five dev versions attach and round-trip at **full fidelity** through a single vendored backend —
identical tree, identical `operations` opcode profile, identical hooks/state/context
readback, and the stale-closure bug reproduces on every one. There is **no silent
degradation** on any version, so the abort/second-pivot criterion (§4.4) does **not** trip.
The only cross-version variance is that React 19 resolves `source` for *more* nodes (a
capability gain, not a loss). Recommendation: **v1 = React 16.8 – 19, all first-class**
(§4.5). The real ABI coupling is to the `react-devtools-core` backend we vendor — which
normalizes the Fiber ABI across 16.8→19 — **not** to the app's React version.

## 4.1 Support matrix

Enriched fixture (14 components + 1 root, IDs 1–15) inspected element-by-element and
diffed against `GROUND_TRUTH.md` (captured on 18.3.1). "hooks/state/context readback" =
`useState`/`useContext` values, the custom `useDocumentTitle` sub-hook tree, and
`ThemeBadge`'s two `useContext` values (the bridge-only data) all recovered; "`source`
nodes" = components for which the runtime returns a `[name, url, line, col]` tuple.

| React (build) | attach | renderer meta | mount tree | hooks/state/context | `source` nodes | silent degradation | verdict |
|---|---|---|---|---|---|---|---|
| 16.8.0 (dev) | ✅ | `bundleType 1`, `react-dom` | **14/14** — 1 msg, 15 `ADD` + 1 `SUSPENSE_ADD` | **full** | 8/14 | none | ✅ **works** |
| 16.14.0 (dev) | ✅ | `bundleType 1` | **14/14** — identical opcodes | **full** | 8/14 | none | ✅ **works** |
| 17.0.2 (dev) | ✅ | `bundleType 1` | **14/14** — identical opcodes | **full** | 8/14 | none | ✅ **works** |
| 18.3.1 (dev) | ✅ | `bundleType 1` | **14/14** — identical opcodes | **full** | 8/14 | none | ✅ **works** |
| 19.1.0 (dev) | ✅ | `bundleType 1` | **14/14** — identical opcodes | **full** | **12/14** | none | ✅ **works** |
| 18.3.1 (**prod**) | ✅ | **`bundleType 0`** | **14/14** — identical opcodes | values readable; **edit surface off** | 8/14 | n/a (by design) | ⚠️ **`production_build_detected`** (§4.3) |

The delta stream is identical across all five dev versions too: `increment()` (pure state)
→ **0** `operations`; `addTodo()` → `ADD` + `REORDER_CHILDREN` + `SUSPENSE_RESIZE`; `reorderTodos()`
→ `REORDER_CHILDREN`; stale-closure → `liveCount 6 / staleObserved 0` on every version; transport
`gaps: 0, parseErrors: 0` throughout. In other words, everything §2/§3 established on 18.3.1
holds **unchanged** on 16.8/16.14/17/19 — the v7 `operations` format and the dehydrated
`inspectElement` envelope are version-invariant because the *backend* produces them, not the
app's React.

## 4.2 The one real difference — `source` coverage & coordinates vary by version

`source` is the only axis that moves across versions, and it moves in the *favorable*
direction. Recall (§2.5/§3.4) the tuple is **not** Babel's `__source` (ignored) — it is
derived at runtime from React's own **component-stack machinery**, which React 19 rewrote.
The same served fixture bytes drive all four versions, so every difference below is purely
React-version-driven: **16/17/18 are byte-identical; only 19 diverges**, and only ever by
*adding* information (nothing that resolved on 18 regressed on 19).

The 14 components fall into three buckets (coordinates are `line:col` into
`enriched.fixture.js`, whose components are all `function X() {` declarations at col 3):

| bucket | components | 16 / 17 / 18 | 19 | what moved |
|---|---|---|---|---|
| **GAINED** | `App`, `Layout`, `Header`, `Main` (createRoot-owned / structural) | ❌ `null` | ✅ `195:3` / `191:3` / `178:3` / `182:3` | null → **declaration** |
| **MOVED** | `ThemeProvider`, `SettingsProvider`, `TodoList` | `63:13` / `75:13` / `159:28` (first hook call) | `62:3` / `74:3` / `158:3` | interior → **declaration** |
| **SAME** | `ThemeBadge`, `StaleCounter`, `TodoItem×3` | `86:13` / `97:23` / `153:29` | identical | — |
| **never** | both `Context.Provider` fibers | ❌ `null` | ❌ `null` | — |

So §3.4's "`source` is null for the root / structural / provider components" is
**version-specific**: on React 19 the null-set shrinks to just the two `Context.Provider`
fibers, and where 16–18 point at an *interior* line (the first hook call, or — for the
hookless `TodoItem` — inside its `createElement`), 19 points at the **`function`
declaration**. The MOVED-vs-SAME split correlates with whether a component renders
component-children vs only host-children, but that causal path is unconfirmed.

**Mechanism (hedged).** The shift is consistent with React 19 removing `_debugSource` and
replacing its fake-throw component-stack capture with **owner stacks / `console.createTask`**;
the backend's source resolver rides that machinery, so the frame it lands on both shifts
(interior → declaration) and widens (structural components become resolvable). This is read
off the data, not traced through the backend resolver — the observable shift is asserted,
the exact code path is not.

**Consequence for Layer 3 / RDT source tools (LEO-360).** Source is version-variant along
**three** axes — coverage (which nodes resolve), coordinate value, and coordinate semantics
(interior vs declaration) — so:

- **Resolve to the enclosing symbol / range, never treat the `line:col` as authoritative.**
  The same component in the same file resolves differently across a React major; a
  "jump to source" or sourcemap lookup keyed on the exact point will drift on upgrade.
- **Keep `source` best-effort per node** with the §3.4 displayName/tree-position fallback,
  and do **not** hard-code the 16–18 null-set (it shrinks on 19).
- **Don't pin exact `line:col` in golden tests across versions** — assert presence +
  enclosing-symbol resolution.
- **Caveat on generalization:** measured on *unminified dev builds* with no bundler/sourcemap
  in the loop. Real apps add a bundler + sourcemaps downstream (version-independent), but the
  React-version shift is *upstream* of the sourcemap and perturbs the coordinate it
  translates — re-confirm under a real Vite/webpack + sourcemap pipeline in S6 / RDT-2.

This is a *soft* caveat (more data on newer React, never less); it is **not** a degradation.

## 4.3 Production-build detection — `production_build_detected` (signal validated, envelope proposed)

Loading a real React **production** build (`react-dom.production.min.js`) confirms the §5.1
model empirically and sharpens it:

- The prod renderer **still injects** into `__REACT_DEVTOOLS_GLOBAL_HOOK__` and the backend
  **still attaches** with a **complete 14/14 tree** — so "hook absent / no renderer" is
  emphatically **not** the production signal (that is *not-connected*).
- The renderer reports **`bundleType: 0`** (dev builds report `1`). This is the load-bearing,
  attach-time signal.
- **Every element returns `canEditFunctionProps: false` and `canEditHooks: false`** — the
  DEV-only override surface is gone. This corroborates `bundleType 0` per-element.
- **Surprise / correction to §5.1's "names & props stripped":** in this build `source`
  **survived** for the same 8 nodes as dev-18 (it is derived from a runtime Error stack of
  the *app's* unminified functions, which a React prod build does not touch), and the tree
  is complete. **Name/source stripping is therefore a property of app-code minification, not
  of React's `bundleType`** — do **not** use it to detect production. The reliable
  discriminators are **`bundleType 0` + `canEdit* === false`**, exactly as §5.1's "detect by
  the right signal" bullet argued; S4 confirms it with data and drops the name-stripping
  heuristic.

**What's validated vs proposed.** S4 validates the *signal* — a prod renderer attaches with
`bundleType 0`, every element reports `canEdit* === false`, and `s2/probe-prod.mjs` raises a
`production_build_detected` off it. The *envelope shape* is a **proposal, not the current
contract**: today the tool wrapper (`src/tools/_register.ts`) serializes any thrown
`ToolError` as a **flat** `{ "error": code, "message": msg }` inside an `isError: true`
result, and `ToolError` (`src/util/errors.ts`) carries only `code` + `message` — **no
`recoverable` flag, no `data` payload** (the same shape `README.md` / `src/tools/README.md`
document). So:

*Current contract* — emittable today with no wrapper change:

```json
{ "error": "production_build_detected", "message": "React production build (renderer bundleType 0); lynceus blocks override writes against production renderers. Rebuild in development mode for prop/hook overrides." }
```

*Proposed enrichment (S6 / LEO-363)* — carries the machine-usable signal, but **requires
extending `ToolError` + `_register.ts`** to thread `recoverable` + `data` through the wrapper
(don't implement it from this section as if it already ships):

```json
{ "error": "production_build_detected", "recoverable": false, "message": "…", "data": { "bundleType": 0, "rendererPackageName": "react-dom", "rendererVersion": "18.3.1-next-…" } }
```

> The `rendererVersion` above is verbatim what the **stable** `react-dom@18.3.1` production
> UMD self-reports (`18.3.1-next-f1338f8080-20240426`) — React's 18.3.1 production build
> embeds an internal `-next-<hash>-<date>` string. It is the real observed value, **not** a
> canary fixture; a prod-detection tool should key on `bundleType`, never parse this string.

**Read vs write — the contract (resolving the earlier ambiguity).** `production_build_detected`
is a **write-side hard error, not a session-level one.** By deliberate LEO-466 safety policy,
the override tools (`override_react_props` / `override_react_hook_state`, LEO-363) **block every
write against a production renderer**. That includes class-component props/state/context writes
that the backend could technically perform; the blanket block is lynceus policy, not a React
limitation. Development writes still honor per-element `canEdit*` capability. The **read** tools
(`get_react_tree` / `inspect_react_component`) do **not** fail: they return the complete tree and
the surviving values, ideally tagged once with a `production_build_detected` **warning
annotation** so the agent knows the edit surface is off and names may be degraded.
Non-recoverable *for writes*, non-fatal *for reads*.

## 4.4 Abort / second-pivot check

The criterion: do **18 and 19** silently degrade in ways with **no attach-time signal**
distinguishing a working session from a degraded one?

| question | finding | tripped? |
|---|---|---|
| do 18/19 degrade (incomplete tree / missing values)? | full fidelity — 14/14 tree, full readback, 0 gaps | **no** |
| is degradation, if any, *invisible* at attach? | n/a (no degradation); and `bundleType` + renderer `version` **are** exposed at attach as signals | **no** |
| does the floor need to collapse to a single version + `unsupported_react_version`? | no — 16.8→19 all first-class through one backend | **no** |

**Not tripped. No hard version assertion is required at attach for v1.** (A forward guard is
still worth *defining* — see §4.6 — but as a guard for React <16 / a hypothetical future
ABI break, not to gate 16–19.)

## 4.5 Recommended v1 support floor

**v1 = React 16.8 – 19, all first-class for read/inspect (single tier).** Rationale:

- **Empirically, 16.8.0 / 16.14.0 / 17.0.2 / 18.3.1 / 19.1.0 are indistinguishable** at the
  bridge: same attach, same `operations` v7 format, same `inspectElement` envelope, same
  hooks/state/context fidelity. There is no technical basis for a `18+` restriction or a
  "16/17 best-effort" tier — the ticket's example floor is *more* conservative than the data
  warrants.
- **Lower bound = 16.8, tested (not just inferred).** `16.8.0` — the *first* hooks release,
  i.e. the exact lower bound — was spot-checked (round 2) and round-trips at full fidelity
  (14/14 tree, 8 source nodes, full hooks/state/context, stale-closure, 0 gaps), matching
  `16.14.0`. **Both endpoints of 16.x's hooks era are tested, so 16.9–16.13 are interpolated
  between two measured points**, not blind extrapolation. **16.0–16.7** (Fiber but pre-hooks,
  class components only) is **best-effort/untested** — tree + props + state should work via
  the same backend, but no hooks exist to read. **React ≤15** (stack reconciler, no
  `supportsFiber`) is **out** — the Fiber backend cannot attach.
- **Read-floor vs override-floor.** The above is the **read/inspect** floor (what S4's
  read-only fixture measures). If the **override** tools (LEO-363) join the first-class
  surface their floor is higher, per §5.4: `overrideProps` needs React ≥16.7 (OK on 16.8),
  **`overrideHookState` needs ≥16.9** (so 16.8 is read-first-class but *not* hook-state-
  override-capable), and delete/rename-path edits need ≥17. This caveat rides on §5.4's
  reconciler-source evidence, not an S4 measurement.
- **The coupling that actually matters is the vendored `react-devtools-core` backend**, not
  the app's React version. Pin and track *it* (currently `7.0.1`); a future React that breaks
  the ABI is a backend-bump problem, surfaced via the attach-time `version` + the §4.6 guard,
  not a per-version-page problem in our code.

## 4.6 Net effect on the layer design (§1)

- **No architecture change; no pivot.** The 5-layer seed and the S3 conclusions carry over
  to 16.8→19 unchanged.
- **Layer 1 (attach) — capture renderer metadata, don't gate on version.** Read
  `bundleType` (→ `production_build_detected`, §4.3) and `version` / `rendererPackageName`
  from each registered renderer at attach. Do **not** assert a React version to *admit* a
  session (16.8–19 all pass). **Do** define an `unsupported_react_version` envelope as a
  forward/lower guard — emit it for React <16 (no `supportsFiber`) and reserve it for a
  future ABI break the vendored backend can't decode — but it is dormant for v1's range.
- **Layer 3 (tools) — source is version-variant.** `find_react_component` / source-map tools
  must tolerate `source: null` on a version-dependent minority (shrinks on 19) and must not
  assume a fixed coordinate origin (§4.2). Read paths may warn-and-continue in prod rather
  than hard-fail; only `canEdit*` writes must hard-fail with `production_build_detected`.
- **Track the backend, not React.** Record `react-devtools-core@7.0.1` as the ABI anchor;
  the matrix should be re-run only when that backend or a new major React lands. → input for
  S6 (LEO-217) and RDT-2/RDT-5.

---

# §5 — Surveys (LEO-216)

Four parallelizable surveys that don't depend on the S2 gate. They feed S6 synthesis; none of them author the final design. Each subsection is tagged with the follow-on ticket it informs.

## 5.1 OSS prior-art audit

Three existing MCP projects were audited for **bridge-message-handling patterns** we can lift into a CDP-binding-based Wall. Verdict up front: only one of the three is a real react-devtools bridge; it is small but feature-complete and — crucially — already abstracts the Wall transport behind a seam that a CDP binding drops straight into.

| Repo | Relevance | Attach model | Decodes `operations`? | Maturity | License |
|---|---|---|---|---|---|
| `ChakshuGautam/react-devtools-mcp` | ~none | `react-devtools-core/standalone` WS server on `:8097` | No | POC, 0★, single commit | MIT |
| `skylarbarrera/react-devtools-mcp` (npm `react-devtools-bridge`) | **very high** | own `ws` server on `:8097` **or** raw WS client to a standalone; **Bridge decoupled from transport** via `attachToExternal()` | **Yes — full hand-rolled decoder** | ~1★, feature-complete (40+ tools), last commit 2026-01-31 | MIT |
| `mcpc-tech/dev-inspector-mcp` | partial/adjacent | build-time-injected client + React fiber traversal + optional `chrome-devtools-mcp` (CDP) passthrough | No (uses fiber name + `data-insp-path` source attrs) | mature: 44★, 326 commits, active | MIT |

### Per-repo notes

- **`ChakshuGautam/react-devtools-mcp` — skip.** Explicitly a proof-of-concept. Whole server is one file; it calls `standalone.startServer(8097)` and injects `<script src="http://localhost:8097">` into a test app in dev. Exposes only `ping` / `check_react_connection` / `get_devtools_status`. **Never reads a single bridge message.** Confirms the naive "standalone on 8097" baseline and nothing else.

- **`skylarbarrera/react-devtools-mcp` — the one to lift from.** A from-scratch TS reimplementation of the react-devtools Wall/Bridge, deliberately decoupled from transport. Two attach paths (its own `WebSocketServer`, or a raw `ws` client to an existing standalone) both feed the *same* transport-neutral Bridge via a plain listener seam:
  - `addMessageListener(fn)` / `sendMessage(event, payload)` — the Wall reduced to an inbound `(event,payload)⇒void` + an outbound `send`. `bridge.attachToExternal()` binds the Bridge to any such pair. **That is exactly the shape a CDP binding provides.**
  - Hand-rolled **`operations` decoder**: 1-based string table (`utfDecodeString`), op constants `ADD=1 / REMOVE=2 / REORDER=3 / UPDATE_TREE_BASE_DURATION=4 / UPDATE_ERRORS_OR_WARNINGS=5`, root-vs-non-root ADD layouts, plus **bounds-checking hardening** upstream doesn't have.
  - **Element-id ↔ component maps** (`elements`, `elementToRenderer`, `renderers.{rootIDs,elementIDs}`); `get_component_tree` returns a **snapshot reconstructed from cached state**, not a replayed stream.
  - **`inspectElement` request correlation** with a fallback chain `responseID → requestID → element id` — important because a binding is fire-and-forget.
  - Dehydrated-data model (`{cleaned,data,unserializable}`, path-based lazy hydration) and `overrideValueAtPath(kind,id,path,value)` for all writes.
  - **Weaknesses to avoid:** no readiness gate (tool calls fire before the bridge is up; startup-connect failure is swallowed), no dev-build detection, a **flat** error hierarchy with no recoverable/non-recoverable split, and reconnection logic that is entirely WS-close-code driven (does **not** transfer to CDP).

- **`mcpc-tech/dev-inspector-mcp` — different architecture, one useful trick.** A build-time `unplugin` that injects a client and walks the React fiber at click time; it does **not** use `__REACT_DEVTOOLS_GLOBAL_HOOK__`, `react-devtools-core`, or the Wall protocol at all. Its `sourceDetector` resolves "which file/line" via build-time `data-insp-path`/`data-source` attributes (primary) → fiber `_owner`/`return` walk to the nearest component (fallback) → a `window.__SOURCE_INSPECTOR__` global. It is also the only prior-art that composes an MCP tool surface with **real CDP** (it bundles `chrome-devtools-mcp` behind a `chrome_devtools` tool), validating the CDP-native direction — though it shells out to another MCP rather than carrying react-devtools messages over CDP.

### What to lift into a CDP-binding bridge (transport-independent, payload-level)

1. **The Wall-as-two-functions seam** (`skylarbarrera`'s `attachToExternal()` / `addMessageListener`+`sendMessage`). Model the CDP binding as that pair. See §5.4 — `react-devtools-core` itself exposes `connectWithCustomMessagingProtocol(...)` for exactly this, so we may not even need to hand-roll the Wall.
2. **The `operations` decoder** — string table + `TREE_OP` constants + root/non-root ADD layouts + bounds-checking. Identical regardless of WS vs CDP framing.
3. **Element-id ↔ renderer maps** and **snapshot reconstruction** for `get_react_tree` (accumulate patches → serve a snapshot; don't replay the stream per call).
4. **`inspectElement` request correlation** (`responseID → requestID → id` fallback) — a CDP binding is inherently async/fire-and-forget, so this matters *more* for us than for a WS.
5. **Dehydrated-data model + `overrideValueAtPath`** as the read and write payload shapes.
6. **The tool taxonomy** (tree / inspect / mutate / profile / errors / filters) as a ready-made surface map for Layer 3.

### What **not** to lift (WS-specific)

- Reconnection/backoff keyed on WS close codes. Under CDP there is no socket to reconnect; **navigation is the real lifecycle event** (`Page.addScriptToEvaluateOnNewDocument` re-runs the shim on every document, but the element/renderer maps + string tables must be **reset per navigation/renderer-remount** or ids go stale). → feeds **S3 (LEO-214)**, which owns the lifecycle/event model.
- The raw `ws`/`:8097` topology and standalone-script injection.

### Pitfalls observed (design guardrails)

- **Add an explicit readiness gate.** Don't answer a tool call until the binding handshake completed *and* the initial `operations` snapshot arrived; otherwise return a structured "bridge not ready / dev-build not detected" error. (Both real bridges lack this.)
- **Use lynceus's structured `{error, message}` tool-error shape** — flat today (`ToolError` → `{error, message}` via `src/tools/_register.ts`; there is **no** `recoverable`/`data` taxonomy in code, see §4.3). Map the RDT error codes (`NOT_CONNECTED / TIMEOUT / ELEMENT_NOT_FOUND / INTERNAL_ERROR / NOT_EDITABLE`) onto it; if S6 needs machine-readable recoverability/data, adopt §4.3's richer-envelope **proposal** (which extends `ToolError` + `_register.ts`).
- **Detect production builds by the *right* signal — and split it from "not connected."** Absence of `__REACT_DEVTOOLS_GLOBAL_HOOK__` / no renderer after injection is **not** a production signal: production React renderers still inject into DevTools, with `bundleType: 0`. What's missing in a prod build is the **DEV-only edit surface** (`overrideProps` / `overrideHookState`), reflected in the per-element `canEdit*` flags. So distinguish three states rather than conflating them: (a) **not-connected / no renderer attached** (hook absent → the backend didn't install or nothing rendered); (b) **production renderer attached** (`bundleType: 0`, edit internals absent → surface `production_build_detected`, an LEO-209 deliverable — read-only may still partly work but names/props **may be degraded** — see §4.3); (c) **dev renderer** (editable). Inject the hook shim *before* any app script runs regardless, and gate editability on renderer metadata + `canEdit*`, **not** on hook presence. (Per maintainer review on the pre-rename repo.)
- **Pin the targeted `react-devtools-core` version + negotiate `bridgeProtocol`** so a protocol bump is *detected*, not silently mis-decoded (the reference bridge inlines numeric constants and a `version:2` handshake).

### Vendoring safety

All three are **MIT**. `skylarbarrera` is the one to vendor *selectively* (small, low-adoption → treat as reference code copied under MIT attribution, not a dependency). If a robust "which file/line" mapping is wanted, `mcpc-tech`'s `sourceDetector` fiber-walk is a clean MIT complement. Check transitive licenses if we take more than patterns (`skylarbarrera` pulls `react-devtools-core ^6`; `mcpc-tech` bundles `chrome-devtools-mcp ^0.20`).

## 5.2 React bug taxonomy (operator-facing)

The bug classes the operator actually hits, scored on the axis that matters for this project: **is runtime component inspection load-bearing, or does source-reading already solve it?** That axis drives both the Layer-3 tool surface and the L4 oracle design (§5.3).

| # | Bug class | Runtime symptom | Source-reading sufficient? | React-bridge tool that surfaces it | Primarily drives |
|---|---|---|---|---|---|
| 1 | **Stale closure** (`useEffect`/`useCallback` captures old state/props) | handler/effect uses an outdated value (e.g. an interval counter stuck at 1) | **Partial** — the empty/missing dep array is source-visible; the bridge instead confirms the *current* hook state (the frozen symptom) | `inspect_react_component` (current hook `memoizedState`) — **note:** DevTools does **not** expose lexical closure bindings or effect deps (see §5.3 Scenario A) | canonical L4 #1; `inspect_react_component` |
| 2 | **Missing/incorrect `useEffect` deps** | effect doesn't re-run, or re-runs too often | **Mostly yes** — `react-hooks/exhaustive-deps` catches most statically; the dep-array diagnosis is source/lint-side | profiler (re-run rate) + `inspect_react_component` *indirectly* (current state/context) — **not** the effect's `deps`, which DevTools does not surface (same limit as row 1; see §5.3 Scenario A) | contrast/control case |
| 3 | **Context misuse** (default value used; or a nearer Provider overrides with an unexpected runtime value) | component renders with the wrong themed/config/locale value | **No** — which Provider *wins* and what value it holds depends on the **runtime tree**, not any single file | `inspect_react_component` (resolved context value) + `find_react_component`/`get_react_tree` (locate nearest Provider) | canonical L4 #2; the bridge-mandatory case |
| 4 | **Wrong prop from an ancestor** (esp. via `children`/portal composition) | component renders with an unexpected prop | **Partial→No** — must trace the runtime tree; lexical tracing breaks under composition | `inspect_react_component` (actual props) + `get_react_tree` (owner chain) | `inspect` + tree |
| 5 | **Unnecessary re-renders / profiling regression** (unstable prop/context identity, missing memo) | jank; component re-renders when it shouldn't | **No** — needs commit / "why did this render" data | `start_react_profiling` + `stop_react_profiling` + `get_react_profile` | profiler tools (LEO-9X.5) |
| 6 | **Key / reconciliation bug** (index keys) | list-item state bleeds/resets on reorder | **Partial** — the index key is visible, the state-bleed is a runtime effect | `get_react_tree` (keys) + `inspect_react_component` (per-item state) | tree + inspect |
| 7 | **Hydration mismatch** (SSR) | content flip / hydration warning / lost interactivity | **Partial** — the server/client branch is visible; the mismatch is runtime | existing console tools (primary) + `get_react_tree` (secondary) | mostly existing console surface |
| 8 | **State-not-updating** (stale `setState`, missing functional update) | rapid updates drop values | **Partial** | `inspect_react_component` (hook state) + (stretch) overrides to test the hypothesis | `inspect` + overrides |

### What the taxonomy implies

Two clusters fall out:

- **Source-solvable** (rows 2, and the "read the source and reason" path for 1/6/7/8): a competent source-reading agent can often name the bug *without* touching the bridge.
- **Runtime-only** (rows 3, 5, and the composition cases of 4): the answer depends on the assembled runtime tree / commit data and is **not** recoverable from any single source file.

The runtime-only cluster is what **justifies the React bridge existing at all**, and — critically — it is what makes the L4 **MECHANIC** axis meaningful. A tool surface built only around source-solvable bugs would be redundant with `get_script_source`. This is the direct line from taxonomy → tool surface (Layer 3) → oracle (§5.3).

**Overrides amplify this** (see §5.4): for rows 4/8, being able to *write* a prop or hook-state value turns read-only inspection into interactive hypothesis-testing ("flip this value — does the symptom clear?"), a capability a pure source debugger cannot offer. (Overrides write *current* state, so they can unstick row 1's symptom but don't fix the closure itself — the diagnosis there stays source-side.)

→ Feeds the Layer-3 tool list and the L4 oracle. Bug rows map 1:1 onto the reshaped LEO-9X.3 (read-only inspection MVP), .5 (profiler), .6 (overrides).

## 5.3 L4 eval scenario sketches — two scenarios (sketch only)

House L4 style (see [`evals/README.md`](../evals/README.md), [`docs/test-eval-plan.md`](./test-eval-plan.md)): each scenario is a `Scenario` object (`name`, `variantDir`, `prompt`, `oracle`, `oracleMinimumToolCalls`) with a **pure-function dual-axis oracle** — no LLM judge:

- **CORRECTNESS ∈ {0,1}** — does `finalAnswer` name the bug (pattern match)?
- **MECHANIC ∈ {0,1}** — did the agent exercise the workflow the scenario tests (here: *use the React bridge*, not `get_script_source`)?

### Why two scenarios (the crux)

The ticket is explicit: *"a single source-solvable bug produces false negatives"* on the MECHANIC axis. The repo already documents the evidence — the "lazy solver" pattern where `adversarial-out-of-order` surfaces as `XPASS!` ([`evals/README.md`](../evals/README.md)), i.e. models get **correctness=1 via source-reading with mechanic=0**. (The related `conditional-bp` 7/8-ceiling finding is tracked in **LEO-246**, not recorded in-repo.) With a lone source-solvable scenario you **cannot distinguish** "the agent chose the source shortcut" from "the React tools are broken/useless" — both read as mechanic=0.

The two scenarios are chosen to break that ambiguity:

- **Scenario B is bridge-mandatory** (source-reading genuinely insufficient). A correct answer on B is only reachable through the bridge, so **correctness ⇒ mechanic co-move**. B therefore *proves the bridge is functional and load-bearing*.
- **Scenario A is source-solvable** (the bug is visible in source). It is the control that *isolates the behavioral question*: given a shortcut, does the agent still reach for the bridge? On A, mechanic=0 with correctness=1 = **lazy-solving** — and because B has already proven the bridge works, we can attribute A's mechanic=0 to behavior, not a broken tool.

One scenario can't do both jobs. Together they let the MECHANIC axis actually discriminate.

> Implementation is **LEO-361 (RDT-3)** — its title ("stale-closure + provider-context, dual-axis oracle") matches these two exactly. This is sketch-only.

### Scenario A — `react-stale-closure` (source-solvable control)

- **Variant:** `evals/sample-app-variants/react-stale-closure/` — a minimal React **dev-build** page with an auto-incrementing counter.
- **Bug:** the counter never advances past 1:
  ```jsx
  // Counter.tsx
  useEffect(() => {
    const id = setInterval(() => setCount(count + 1), 1000); // captures count === 0 forever
    return () => clearInterval(id);
  }, []); // ← empty deps: the interval closes over the initial render's `count`
  ```
- **What the bridge can and can't see here (important — shapes the mechanic).** React DevTools hook inspection re-renders the component and returns the *current* hook state (`useState`'s `memoizedState`, i.e. `count` frozen at `1`) and, for `useEffect`, the hook's `value` is the effect's **`create` function object** — `react-debug-tools` (`ReactDebugHooks`) does **not** surface the effect's `deps` and cannot read the interval callback's **lexical closure binding** of `count`. So the bridge's honest role in this scenario is to **confirm the runtime symptom** (the counter's state is frozen at 1), *not* to read "the closed-over value." The stale-closure **diagnosis stays source-solvable** (the empty dep array is right there) — which is exactly what makes A a valid *source-solvable control*. (Per maintainer review on the pre-rename repo.)
- **Prompt (SDET framing):** *"Test plan: the page's auto-incrementing counter is stuck at 1 instead of climbing. Attach the React inspector, locate the counter component, and inspect its current hook state to confirm the counter's value is frozen at runtime; then explain from the source why it never advances. Report the bug as file:line (or the hook/effect at fault)."*
- **Oracle sketch** (compute-step shape):
  ```ts
  function oracle(trace, finalAnswer): OracleResult {
    const calls = toolPairs(trace);
    // MECHANIC — used the bridge to read the counter's CURRENT hook state (real DevTools data), not get_script_source
    const attached  = calls.some(c => c.tool === "attach_react_devtools" && !c.isError);
    const inspected = calls.some(c => c.tool === "inspect_react_component" && !c.isError);
    //   (LEO-361: also assert the returned payload carries the frozen hook value, e.g. count === 1 — see open questions)
    const mechanic  = attached && inspected ? 1 : 0;
    // CORRECTNESS — names the stale closure / empty dep array (source-solvable)
    const fa = finalAnswer.toLowerCase();
    const correctness =
      /use\s?effect|interval/.test(fa) &&
      /stale closure|empty (dependency|deps)|\[\]|captured?.*count|dependency array/.test(fa)
        ? 1 : 0;
    return { correctness, mechanic, efficiency: 0, recovery: 0, notes: `react-stale-closure c=${correctness} m=${mechanic}` };
  }
  // oracleMinimumToolCalls ≈ 6  (attach + get_react_tree/find + inspect + navigate + launch + answer)
  ```
- **Expected signal:** a source-reader can answer correctly with mechanic=0 (the `[]` is right there) → A is the **lazy-solver probe**. The mechanic now keys on data the bridge *actually returns* (current hook state), so a mechanic=1 means the agent genuinely used the bridge to confirm the runtime symptom. The harness has both `xfailCorrectness` **and** `xfailMechanic` tags (the latter added 2026-07-08 and applied defensively to `adversarial-out-of-order` — see `evals/README.md` — for exactly this statically-readable shape); whether A ships with a defensive `xfailMechanic` is an LEO-361 call (open question below). A's value is the mechanic signal itself.

### Scenario B — `react-provider-context` (bridge-mandatory)

- **Variant:** `evals/sample-app-variants/react-provider-context/` — a themed widget that renders with the wrong theme even though the top-level `ThemeProvider` is `"light"`.
- **Bug (constructed so source-reading is genuinely insufficient):** two Providers of the *same* `ThemeContext` at different depths, and the buggy widget is passed as `children` into an intermediate component that renders it **inside** the inner (wrong-value) Provider. Each Provider's value is computed at runtime (from props/state). Reading the widget's file shows only `useContext(ThemeContext)`; reading the top-level file shows `value="light"`. The fault — the **nearest** Provider and its runtime value — is discoverable only by walking the assembled runtime tree.
  ```jsx
  // App.tsx        <ThemeProvider value="light"><Page/></ThemeProvider>
  // Page.tsx       renders {children} but wraps part of its subtree:
  //                <ThemeProvider value={derivedFromState}><Slot/></ThemeProvider>
  // SettingsWidget lands under the INNER provider at runtime → gets the wrong value
  ```
- **Prompt (SDET framing):** *"Test plan: the settings widget renders with the wrong theme even though the top-level ThemeProvider is set to 'light'. Attach the React inspector, find the widget in the component tree, and determine which Provider value it actually receives at runtime. Report which provider supplies the wrong value (component + value)."*
- **Oracle sketch:**
  ```ts
  function oracle(trace, finalAnswer): OracleResult {
    const calls = toolPairs(trace);
    // MECHANIC — attached, then located + inspected via the bridge (attach asserted for symmetry with A)
    const attached  = calls.some(c => c.tool === "attach_react_devtools" && !c.isError);
    const inspected = calls.some(c => c.tool === "inspect_react_component" && !c.isError);
    const walked    = calls.some(c => ["get_react_tree","find_react_component"].includes(c.tool) && !c.isError);
    const mechanic  = attached && inspected && walked ? 1 : 0;
    // CORRECTNESS — must finger the INNER/nearest Provider (the discrimination the scenario exists to test),
    //   not merely any value word. (LEO-361: bare-value branches like `dark` are false-positive-prone — see open questions.)
    const fa = finalAnswer.toLowerCase();
    const correctness =
      /(inner|nearest|nested|page)\s+provider/.test(fa) &&
      /wrong (theme|value|context)|receives|overrides?|overriding/.test(fa)
        ? 1 : 0;
    return { correctness, mechanic, efficiency: 0, recovery: 0, notes: `react-provider-context c=${correctness} m=${mechanic}` };
  }
  // oracleMinimumToolCalls ≈ 7
  ```
- **Expected signal:** source-reading a single file cannot say which Provider wins or what value it holds → correctness on B **requires** the bridge, so correctness and mechanic co-move. B doubles as the per-suite "is the React bridge working end-to-end" smoke (the way `compute-step` is for the debugger).

### Open oracle questions for LEO-361 (the sketches above are intent, not final oracles)

- **Assert bridge-sourced *payload*, not just tool invocation (hard requirement).** Both mechanic checks currently pass on `inspected && !isError`. A model could call `inspect_react_component` on the wrong element (or get a benign result) and still score mechanic=1. LEO-361 should require the returned payload to carry the *expected runtime value* — the frozen `count` for A, the resolved `theme`/context value on the widget for B — so the mechanic proves a real bridge read.
- **Tighten the correctness regexes — they are deliberately loose sketches.** Scenario A's `\[\]` branch matches any brackets in the answer; Scenario B's original bare-`dark` branch matched a common word without identifying the *nearest* Provider (tightened above to require the inner/nearest Provider be named). Both need real pattern hardening (and negative tests) in LEO-361.
- **Anti-`evaluate` guard.** Mirror the driving scenarios' `mutatedViaEvaluate` guard: forbid solving via raw `evaluate` reaching into `__REACT_DEVTOOLS_GLOBAL_HOOK__` directly — the dedicated React tools are what's under test.
- **Decide a defensive `xfailMechanic` for Scenario A.** A is statically readable by design, the same shape that earned `adversarial-out-of-order` its defensive `xfailMechanic` (evals/README.md, 2026-07-08). Decide per model tier whether A carries the tag; a steady `XPASS!` on strong models is the intended bonus signal.
- **Make Scenario B's bug runtime-only by construction (PR #66 review).** The sketch derives the inner Provider's value from props/state; if that state is deterministic from checked-in source, an agent can trace all files and answer with mechanic=0 — defeating bridge-mandatory. Seed the wrong value through genuinely runtime-only state (fetched, randomized, or driven by a harness action) and have the oracle assert the bridge-returned payload carries it.

## 5.4 Overrides-via-bridge feasibility (LEO-9X.6 / LEO-363)

**Question:** does `react-devtools-core` expose writes (`override_react_props` / `override_react_hook_state`) through the **same** bridge protocol as reads — i.e. is LEO-9X.6 cheap (reuse the binding) or expensive (new plumbing)?

**Answer: YES — cheap on the transport axis.** Prop and hook-state overrides travel over the *exact same* Wall/Bridge as `inspectElement`: ordinary `{event, payload}` messages the backend `Agent` already subscribes to. No side channel, no new transport primitive.

### Evidence (facebook/react @main as of 2026-07-05; **symbol names are the durable anchor**, line numbers will drift — see appendix)

- **Custom-Wall seam is a public entry point.** `react-devtools-core/src/backend.js` ships **`connectWithCustomMessagingProtocol({onSubscribe, onUnsubscribe, onMessage, ...})`** (≈`backend.js:338-419`), which builds a `Wall` from three callbacks and wires the full `Bridge` + `Agent` + `initBackend`. Direction mapping for CDP (from the *backend's* perspective):
  - **backend → controller** = `onMessage(event, payload)` → wire to a page function created by `Runtime.addBinding({name:"__lynceusReact__"})` (calling it fires `Runtime.bindingCalled` to our CDP client).
  - **controller → backend** = the `fn` handed to `onSubscribe` → deliver messages into the page via `Runtime.evaluate` (or a resolved binding) that calls each registered `fn({event, payload})`.

  This means we likely **don't hand-roll the Wall at all** — we embed the real backend and hand it a CDP-backed messaging protocol. (Materially de-risks LEO-209 Layer 1; the "custom Wall whose `send` invokes the binding" seed is a library-supported path, not bespoke code. → input for S6.)
- **`Wall` = two functions.** `frontend/types.js:26-30`: `{ listen: (fn)=>unlisten, send: (event, payload, transferable?)=>void }`. Message shape is `{event: string, payload: any}` (`types.js:77-80`). `Bridge` (`bridge.js:318-334`) re-emits every inbound wall message as `emit(event, payload)`; subscribers attach via `bridge.addListener(event, handler)`. `send()` coalesces a microtask flush but keeps **1 logical event = 1 `wall.send`** (`bridge.js:342-431`) — a clean 1:1 with one CDP binding message. **Reads and writes are the same protocol, same direction, same framing.**
- **The write command.** The `Agent` listens for **`overrideValueAtPath`** (`agent.js:333`, handler `agent.js:803-817`) plus legacy split events (`overrideProps` / `overrideHookState` / `overrideState` / `overrideContext`, `agent.js:359-362`) which are compat shims that forward to the unified one. Payload (`frontend/types.js:129-135`):
  ```
  { event: 'overrideValueAtPath',
    payload: { type: 'props'|'hooks'|'state'|'context', id, hookID?, path: (string|number)[], rendererID, value } }
  ```
  The reference bridge (`skylarbarrera`, §5.1) confirms the shape in practice: its `override_props` / `override_state` / `override_hooks` / `override_context` tools **all funnel to a single `overrideValueAtPath` call** — the override tools are thin wrappers.
- **Renderer mechanics** (`fiber/renderer.js:7158-7231`): **class** components (props/state/context) are written by the backend itself (mutate + `forceUpdate()` — no injected function needed); **function** components route props→`overrideProps`, hooks→`overrideHookState`, which are **destructured off the injected `ReactRenderer`** and gate the per-element `canEditFunctionProps` / `canEditHooks` flags returned in `inspectElement`.

### Constraints / caveats (the real cost is here, not in transport)

1. **DEV build required for function components.** `overrideProps` (16.7+) and `overrideHookState` (16.9+) are injected **only under `__DEV__`** in the reconciler (`react-reconciler/src/ReactFiberReconciler.js`: guarded assignments `:717-741`, `:793-802`, `injectIntoDevTools` `:873-895`). In production React they are never attached → `canEdit*` come back `false` and function-component writes **silently no-op**. Class-component props/state/context writes work without them (backend mutates + `forceUpdate`), but still need the backend attached. **Gate on the per-element `canEdit*` flags, not on React version.**
2. **Hooks: state-cell only.** Effective for `useState`/`useReducer` `memoizedState`; **not** for derived values (`useMemo`/`useContext`/selectors) — those recompute on the next render. The legacy (React ≤15) renderer **throws** on hook writes entirely (`backend/legacy/renderer.js:1168-1169`).
3. **Prop overrides are ephemeral.** `overrideProps` writes `fiber.pendingProps`; the **next parent-driven render overwrites it**. Same for hook overrides once a real update re-runs the setter/reducer.
4. **No explicit "clear override."** Restore by writing the original value again (or letting a natural re-render overwrite it).
5. **Advanced edits are 17+.** `overridePropsDeletePath/RenamePath` and `overrideHookStateDeletePath/RenamePath` (the delete/rename path ops) require React 17+.

### Verdict for LEO-363 (RDT-5)

**Transport: cheap** — zero new plumbing; the override tools reuse the exact binding + Wall as the read path, and are thin `overrideValueAtPath` calls. **The complexity that remains is UX/semantics, not transport:** (a) dev-build + `canEdit*` capability gating with a clear "not editable" error envelope; (b) communicating ephemerality/reversibility to the agent; (c) an L4 oracle for a "prove the fix hypothesis by overriding" mechanic (flip a prop or hook-state value from §5.2 rows 4/8, observe the symptom clear). This supports keeping LEO-363 **conditional** — the bridge work is nearly free; the decision is whether the interactive-override UX is worth the caveats. → input for S6.

---

## §5 findings that feed S6 (LEO-217) — pointers, not decisions

These are inputs for the synthesis pass; they are **not** the reshaped design.

- **Layer 1 (transport)** — `connectWithCustomMessagingProtocol` is a supported custom-Wall seam; embedding the real backend + a CDP-backed messaging protocol likely beats a hand-rolled Wall (§5.4). Reuse `skylarbarrera`'s `operations` decoder + id-maps + request correlation (§5.1). **Verify first:** that `connectWithCustomMessagingProtocol` exists with a stable signature across the `react-devtools-core` range we intend to support (pin the version), and **decide the attribution location** for any lifted `skylarbarrera` code (decoder-file header comment / `NOTICE` / `package.json`) — it's MIT, copied-not-depended.
- **Layer 1 contract (build detection)** — split the three states from §5.1: *not-connected / no renderer* (hook absent) vs *production renderer attached* (`bundleType: 0`, edit internals absent → `production_build_detected`) vs *dev renderer* (editable). Gate editability on renderer metadata + per-element `canEdit*`, not on hook presence (maintainer review, pre-rename repo).
- **Layer 3 (tools)** — bug taxonomy (§5.2) maps onto the tool list; the source-solvable vs runtime-only split is the argument for each tool's existence.
- **Open question "deltas vs snapshots"** — `operations` events *are* a delta/patch stream; the tree is reconstructed from patches. `get_react_tree` should serve a **snapshot from accumulated state** (like `skylarbarrera`), not replay (§5.1).
- **Open question "re-attach on reload"** — under CDP, **navigation is the lifecycle event**; maps/string-tables must reset per navigation/renderer-remount. Owned by **S3 (LEO-214)**; §5.1 supplies the constraint.
- **L4 (LEO-361)** — two scenarios (`react-stale-closure` + `react-provider-context`) are required for the MECHANIC axis to discriminate; oracle sketches + open oracle questions (assert bridge-sourced payload, tighten regexes, anti-`evaluate` guard) in §5.3. Note Scenario A's mechanic reads *current* hook state, not lexical closure (§5.3).
- **Overrides (LEO-363)** — feasible over the same bridge; keep conditional on UX, not transport (§5.4).

---

# §6 — Synthesis (LEO-217)

The synthesis pass. S2–S5 landed their findings in §2–§5 as they went, so this is
**consolidation + reshape, not first-draft authoring**: it (a) validates/revises the §1 5-layer
seed against what the spikes found, (b) resolves the three open questions S6 owns — bundle-pinning
and opt-in attach (the two LEO-217 was tasked to close) plus scoping RSC out of v1 — and
consolidates the three the spikes already answered, (c) states the single-source-of-truth
decisions the follow-on tickets cite, and (d) reshapes the LEO-9X.2–.7 candidates into the
(now-filed) RDT-1–6 with revised estimates. It turns the §5 "findings that feed S6 (pointers, not
decisions)" block into decisions; where that block and §6 differ, **§6 wins**.

**Naming note (cdp-mcp → lynceus) — resolved by the LEO-465 port.** The original of this doc
used the pre-rename names throughout — binding `__cdpMcpReact__`, reverse dispatcher
`__cdpMcpReactDispatch__`, bootstrap skip-flag `__CDP_MCP_BRIDGE_BOOTSTRAP__`, package
`cdp-mcp`. The follow-on RDT tickets (LEO-359–364) were filed under the **`lynceus`** project
with the binding locked as `__lynceusReact__` (LEO-359), and this ported copy uses the lynceus
naming (`__lynceusReact__` / `__lynceusReactDispatch__` / `__LYNCEUS_BRIDGE_BOOTSTRAP__` /
`lynceus`) everywhere; the design is unchanged. The reconciliation item formerly logged in §6.5
row 1 is closed by this port.

## 6.1 Architecture — the 5-layer seed, validated / revised

The §1 seed survives the spike intact at the architecture level — **no pivot, no layer added or
removed** (S2 gate GO §2.6, S3 no-pivot §3.8, S4 no-pivot §4.6). Per-layer status:

| Layer | Verdict | Net change from the spike |
|---|---|---|
| **L0** — FrameworkAdapter seam (`src/framework/adapter.ts`, React-only v1) | **validated** | Unchanged. Mirror the eval harness `VendorAdapter` factoring. |
| **L1** — Backend injection | **revised** | The hand-rolled "custom Wall" is gone (below). |
| **L2** — Per-session state | **validated + refined** | Reset granularity pinned to *new-document* nav. |
| **L3** — Tools | **validated, count firmed** | 8 core + 2 stretch; three payload shapes to honor. |
| **L4** — Capability gating | **validated + extended** | Three error envelopes specified. |

**L1 (revised) — embed the real backend; there is no hand-rolled Wall.** The seed proposed "a
custom Wall whose `send` invokes the binding and whose `listen` registers a callback." S2 (§2.1,
§2.2) and S5 (§5.4) supersede that: `react-devtools-core` exposes
**`connectWithCustomMessagingProtocol({onSubscribe, onUnsubscribe, onMessage})`**, and *those three
callbacks are the Wall in protocol form*. We embed the vendored backend and hand it a CDP-backed
messaging protocol — no bespoke Wall code. The proven bootstrap recipe (§2.2, verified against
`react-devtools-core@7.0.1`):

- Set `window.__LYNCEUS_BRIDGE_BOOTSTRAP__ = true` first so a page's inline hook stub self-skips
  (the bundle's `installHook` early-returns if `__REACT_DEVTOOLS_GLOBAL_HOOK__` is already an
  own-property).
- Install the reverse-channel dispatcher. The dispatcher itself is *called* positionally
  (`__lynceusReactDispatch__("event", payload)`, §2.4); what it must hand the backend listener
  registered via `onSubscribe` is a **single `{event, payload}` object** — positional delivery
  to that listener silently no-ops (§2.2).
- `Object.defineProperty(window, 'ReactDevToolsBackend', {set})` so attach fires **synchronously**
  on the UMD root assignment, ahead of React (measured ~30 ms after bootstrap vs React's first
  `hook.inject` at ~290 ms, §3.7).
- In the setter: `backend.initialize()` (installs the rich hook) then
  `connectWithCustomMessagingProtocol(...)`.
- Forward channel: `onMessage(event, payload)` → `window.__lynceusReact__(JSON.stringify({event,
  payload}))` via `Runtime.addBinding` → `Runtime.bindingCalled`. Reverse channel:
  `Runtime.evaluate` → dispatcher → the `onSubscribe` listener.
- **Readiness = sentinel + first `operations` event, not `Page.loadEventFired`** — backend init +
  first commit are async after load (§3.7).

Two L1 additions the spike surfaced: (1) a **`Page.addScriptToEvaluateOnNewDocument` primitive** —
landed in RDT-1 PR 1a, tracked on `SessionState` and replayed to child sessions the
way `pauseOnExceptions` is (this is the pre-React injection guarantee). (2) **Capture renderer
metadata at attach** — `bundleType`, `version`, `rendererPackageName` — the load-bearing inputs for
build-detection (§4.3) and the dormant version guard (§4.6).

**L2 (refined) — reset per new-document navigation, not per history nav.** `reactBridge` on
`SessionState`, cleared on `reset()`, with a generation counter mirroring LEO-120's
`ownedProcessGeneration`. S3 (§3.1) pinned the reset trigger: each *new-document* nav (same-origin,
cross-origin, hard reload) spins up a fresh backend + fresh element-ID space, so the accumulated
maps/string-tables must reset — keyed off the **loader ID changing** on `Page.frameNavigated`, *not*
the bare event (some Chrome builds fire `frameNavigated` on a bfcache restore, which keeps the same
loader ⇒ same generation ⇒ no reset). The binding itself never needs re-adding; CDP keeps it alive
across every nav type tested (§3.1). `RingBuffer<ReactBridgeEvent>` buffers only the structural
`operations` stream — low-pressure (0 events on a pure re-render, §3.3).

**L3 (firmed) — 8 core tools + 2 stretch, three payload shapes.** Core:
`attach_react_devtools` / `detach_react_devtools` / `get_react_tree` / `inspect_react_component` /
`find_react_component` / `start_react_profiling` / `stop_react_profiling` / `get_react_profile`;
stretch (conditional, §5.4): `override_react_props` / `override_react_hook_state`. Three payload
shapes every implementer must honor:

- `get_react_tree` returns the **current server-materialized snapshot** (LEO-466). `operations`
  remains an internal patch stream (§3.2), but the server consumes those deltas; agents never
  receive a cursor or reconstruct the tree themselves.
- `inspect_react_component` decodes the **dehydrated `{data, cleaned, unserializable}` envelope**
  with path-based lazy hydration (§3.3) — values are pulled on demand, never streamed.
- Source-dependent tools tolerate **`source: null` on a version-variant minority** and must not
  treat `line:col` as authoritative — source is runtime-derived, shifts across React majors, and
  widens on 19 (§3.4, §4.2). Resolve to the enclosing symbol/range through the existing
  `mapCdpToOriginal`; the one new piece is a `url → candidates` index (URLs are not unique — §2.5), with `sessionId` preserved
  (§2.5).

**L4 (extended) — three envelopes.** Browser-only via `TOOL_KIND_SUPPORT`; a new `requireReactBridge(s)`
guard modeled on `requirePaused()` returns **`no_react_bridge`**. Plus **`production_build_detected`**
(§4.3 — a *write-side* hard error / *read-side* warning; see §6.3) and **`unsupported_react_version`**
(§4.6 — a **dormant** forward/lower guard for React <16 / no `supportsFiber`, *not* a gate on the
16.8–19 range).

## 6.2 LEO-209 open questions — all resolved

All six of the parent ticket's open questions are now answered — the three S6 owns (the two
LEO-217 was tasked to close, plus the RSC scoping) plus the three the spikes already settled:

| # | Open question (LEO-209) | Resolution | Owner |
|---|---|---|---|
| 1 | Pin one `react-devtools-core` bundle vs ship multiple + version-detect | **Pin one — `react-devtools-core@7.0.1`.** A single vendored backend normalizes the Fiber ABI across React 16.8→19 at full fidelity (§4.1); the real coupling is to *this backend*, not the app's React, so multiple bundles buy nothing. Track/bump the backend, not per-React pages. | **S6** ← S4 §4.5 |
| 2 | `attach_react_devtools` opt-in vs auto-attach default | **Opt-in per session.** S3's Pivot-2 did not trigger: the binding survives every nav type and reattach is automatic + cheap (§3.1), so manual attach stays viable. Keep the opt-in tool; do not auto-attach. | **S6** ← S3 §3.1 |
| 3 | RSC (React 19+) agent-debuggable surface | **Out of v1 — client components only.** RSC payloads are partially opaque; the read/inspect surface targets client components. File a **separate RSC follow-on** (not one of RDT-1–6). | **S6** |
| 4 | Subscription deltas vs full-tree snapshots | **Internal delta stream, public current snapshot.** `operations` is a patch stream (§3.2), which the server consumes into materialized state; `get_react_tree` returns that current snapshot with no agent-facing cursor (LEO-466). | S3 §3.2 + LEO-466 |
| 5 | Source-map round-trip `componentId` ↔ `file:line:col` | **Feasible via existing machinery.** `mapCdpToOriginal` suffices; the only new piece is a `url → candidates` index (with `sessionId` threaded; URLs are not unique — §2.5), and tools tolerate `source: null` (§2.5, §3.4, §4.2). | S2 §2.5 / S3 §3.4 |
| 6 | Re-attach on reload — does the binding survive `Page.frameNavigated`? | **Yes, all nav types.** The binding + injected bootstrap survive same-origin, cross-origin, back/forward (bfcache), and hard reload; state resets per new-document nav (§3.1). | S3 §3.1 |

## 6.3 Consolidated decisions (single source of truth)

The follow-on tickets cite this block:

- **Support floor: React 16.8 – 19, first-class for read/inspect, single tier** (§4.5). 16.8.0 /
  16.14.0 / 17.0.2 / 18.3.1 / 19.1.0 are indistinguishable at the bridge for attach, tree, and
  hooks/state/context readback — the sole cross-version variance is `source` coverage/coordinates,
  which only *widens* on React 19 (§4.2). **Override floor is higher:** `overrideProps` needs ≥16.7 (OK on 16.8), **`overrideHookState` needs ≥16.9** (so 16.8
  is read-first-class but *not* hook-state-override-capable), delete/rename-path edits need ≥17.
  16.0–16.7 (pre-hooks) best-effort/untested; **React ≤15 out** (no `supportsFiber`). **Track the
  vendored backend (`@7.0.1`), not React.**
- **Bridge lifecycle:** opt-in attach; binding survives every nav; generation reset per
  new-document nav (loader-ID change), not per history nav.
- **Frame scope:** main-frame React trees only in v1 (LEO-466). The generic pre-document transport
  may inject into child realms, but bridge events from non-main frames are ignored
  deterministically; multi-frame identity and reverse routing are deferred.
- **Tree-event model:** `operations` is an internal delta/patch stream; `get_react_tree` returns
  the current server-materialized snapshot. Agents do not consume cursors or reconstruct trees.
- **Build detection:** the reliable discriminators are **`bundleType 0` + per-element `canEdit* ===
  false`** (§4.3) — *not* name/source stripping (that is app-minification, not React's `bundleType`).
  `production_build_detected` is a **write-side hard error for every production override** by
  deliberate LEO-466 safety policy (including technically possible class-component writes), and
  a **read-side warning annotation** (tree + surviving values still return):
  non-recoverable *for writes*, non-fatal *for reads*. (Exact warning-field shape — a top-level
  flag vs a one-time metadata tag — is deferred to RDT-1/RDT-2.)
- **Transport:** embed the real backend + `connectWithCustomMessagingProtocol`; no hand-rolled Wall.
  Reuse `skylarbarrera`'s `operations` decoder + id-maps + request-correlation as reference code
  (MIT, copied-not-depended — §5.1), attribution in a file-header comment.

## 6.4 Reshaped LEO-9X.2–.7 → RDT-1–6 (filed) + revised estimates

The spike de-risked the epic materially, so the candidate LEO-9X.2–.7 tickets were reshaped and
**filed 2026-07-05 as RDT-1–6 (LEO-359–364)**. The mapping is LEO-9X.(N+1) = RDT-N:

| LEO-9X | Filed | Scope | Orig est | Revised est |
|---|---|---|---|---|
| .2 | **RDT-1** / LEO-359 | FrameworkAdapter seam + `addScriptToEvaluateOnNewDocument` + bridge + attach/detach (L0–2) | 8–10d for .2+.3 | ~2–3d |
| .3 | **RDT-2** / LEO-360 | read-only inspection MVP (`get_react_tree` / `inspect_react_component` / `find_react_component`) | (same .2+.3 budget) | ~2–3d |
| .4 | **RDT-3** / LEO-361 | two L4 eval scenarios + dual-axis oracle | 2–3d | ~1.5–2d |
| .5 | **RDT-4** / LEO-362 | profiler tools (`start`/`stop_react_profiling` / `get_react_profile`) | 6–8d for .5+.6+.7 | ~1.5–2d |
| .6 | **RDT-5** / LEO-363 | overrides (conditional) — `override_react_props` / `override_react_hook_state` | (same .5+.6+.7 budget) | ~1–1.5d |
| .7 | **RDT-6** / LEO-364 | docs sweep + SECURITY.md addendum + support-floor doc | (same .5+.6+.7 budget) | ~0.5–1d |

The LEO-209 originals were **grouped, not per-ticket** — `.2+.3 = 8–10d`, `.4 = 2–3d`,
`.5+.6+.7 = 6–8d`, i.e. **~16–21d for the .2–.7 follow-on**. (LEO-209's headline **19–25d
end-to-end** ceiling adds the now-complete **3–4d spike (.1)**: 16–21 + 3–4 = 19–25.) **Reshaped
total: ~8.5–12.5 days**, a **~40–45% cut** to the .2–.7 follow-on (16–21d → 8.5–12.5d). What shrank
it: S2 proved the bridge round-trip end-to-end with the library's own public API (no monkey-patch,
no WebSocket fallback); S4 collapsed the version risk to a single vendored backend (no per-version
code); S3 settled lifecycle + event model and left a reusable recipe + `operations` decoder — so
each ticket is "one Opus session" sized rather than a research effort. **RSC is scoped out of v1**
(§6.2 #3) → a separate follow-on to file, not counted above.

## 6.5 Ticket reconciliation / audit of the filed RDT-1–6 (for review)

S6's audit of the pre-filed tickets against this synthesis. Each row is an item for the user to
apply to Linear; **RDT-6 (LEO-364) prunes this subsection** once reconciled. (S6 does not edit
Linear itself.)

| # | Ticket | Drift vs synthesized design | Suggested action |
|---|---|---|---|
| 1 | RDT-1 (LEO-359), all | Binding `__lynceusReact__`; project `lynceus`. The original doc + spike used the `__cdpMcp*` / `__CDP_MCP_*` page-globals + package `cdp-mcp`. | **Resolved by the LEO-465 port** — this copy uses lynceus naming across all page-globals + the package (§6 naming note). |
| 2 | RDT-2 (LEO-360) | Lists `production_build_detected` as a read-tool error fired "at attach or first inspect." | Reconcile to §4.3/§6.3: read tools **warn** (tree + values still return); only the override *writes* hard-fail. |
| 3 | RDT-2 (LEO-360) | Lists `unsupported_react_version` as an active envelope keyed to the support floor. | Reframe as a **dormant** forward/lower guard (React <16 / no `supportsFiber`); 16.8–19 all attach, no version gate at admit (§4.4/§4.6). |
| 4 | RDT-2 (LEO-360) | "top-level components rendered via `createRoot` can report `source: null`." | Broaden per §3.4/§4.2: null also covers provider/boundary fibers + structural components on 16–18 (set shrinks on 19). Tolerate null generally, not just `createRoot` tops. |
| 5 | RDT-2 (LEO-360) | "RSC … explicitly out of v1 per design doc" — but no RSC follow-on ticket exists. | The design doc now makes the call (§6.2 #3); **file a separate RSC follow-on**. |
| 6 | (unowned) | §4.3's richer `production_build_detected` envelope (`recoverable` + `data`) needs `ToolError` + `_register.ts` changes; today's contract is flat `{error, message}`. | **Recommend RDT-1** (it introduces the first react envelope, so RDT-5 inherits a consistent shape); alternatively RDT-5, or keep flat `{error, message}` for v1 and defer. |
| 7 | RDT-1 (LEO-359) | Bridge model has no frame/execution-context identity: `Page.addScriptToEvaluateOnNewDocument` runs in **every frame** and `Runtime.bindingCalled` carries the originating execution context, so same-process iframes spin up independent backends with overlapping renderer/element IDs while an unqualified `Runtime.evaluate` reverse-routes to the default realm (PR #66 review). | **Decided by LEO-466 (2026-07-23): main-frame React trees only in v1.** Ignore non-main-frame bridge events deterministically; defer multi-frame identity and reverse routing. |
| 8 | RDT-1 (LEO-359) | `detach_react_devtools` has no lifecycle contract: `Runtime.removeBinding` only stops notifications (the page-global function survives), `Page.removeScriptToEvaluateOnNewDocument` only stops future injections, and a same-document reattach cannot rely on the `ReactDevToolsBackend` setter re-firing (the UMD global is already assigned) (PR #66 review). | RDT-1 specifies detach cleanup (invoke the backend's returned unsubscribe, clear `reactBridge`, bump the generation to fence late events), idempotency, and the same-document reattach path. |
| 9 | RDT-5 (LEO-363) | §4.3 ("production ⇒ override writes hard-fail") vs §5.4 (class-component props/state/context writes are backend-side mutations that work without the `__DEV__`-injected hooks); S4's `canEdit* === false` evidence is from an all-function-component fixture (PR #66 review). | **Decided by LEO-466 (2026-07-23): block all production override writes.** This includes technically possible class-component writes and is a deliberate lynceus safety policy, not a React limitation. Development writes still honor per-element capability. |
| 10 | RDT-2 (LEO-360) | "`get_react_tree` is cursor-based" (§3.2/§6.1) vs "serves a snapshot from accumulated state" can read as two different public contracts (PR #66 review). | **Decided by LEO-466 (2026-07-23): current server-materialized snapshot.** The server consumes React's delta stream internally; agents do not reconstruct trees from cursors/deltas in v1. |

---

## Appendix — source citations (for S6 verification)

> **Citation stability.** The line numbers below were captured against `facebook/react@main` on **2026-07-05** and **will drift** — `main` moves. Treat the **symbol/function names as the stable anchor**, not the line numbers. Before S6 relies on any of these, **re-pin every citation to the exact `react-devtools-core@<version>` chosen for vendoring** (and the matching `facebook/react` tag) and re-verify against that pin — the *API surface* (`connectWithCustomMessagingProtocol`, `overrideValueAtPath`, the `operations` opcodes) is stable across the surveyed range; only the numeric anchors are fragile.

**`facebook/react` (@main 2026-07-05, `packages/`):**
`react-devtools-shared/src/frontend/types.js` (`Wall`, `Message`, `FrontendEvents`, `OverrideValueAtPath`, `BRIDGE_PROTOCOL`) · `.../src/bridge.js` (`Bridge`, send/flush) · `.../src/backend/agent.js` (`Agent` listeners, `overrideValueAtPath`, `inspectElement`, `onHookOperations`) · `.../src/backend/types.js` (`RendererInterface`, `ReactRenderer` version fields, `InspectedElementPayload`) · `.../src/backend/fiber/renderer.js` (operations encoding, `overrideValueAtPath` mechanics, `canEdit*` flags) · `.../src/backend/legacy/renderer.js` (React ≤15; hooks throw) · `.../src/hydration.js` (dehydrate/hydrate, `LEVEL_THRESHOLD`) · `.../src/constants.js` (`TREE_OPERATION_*`) · `.../src/hook.js` (`installHook`, build-type classify) · `react-devtools-core/src/backend.js` (`connectToDevTools`, **`connectWithCustomMessagingProtocol`**) · `react-reconciler/src/ReactFiberReconciler.js` (`__DEV__`-gated `overrideProps`/`overrideHookState`, `injectIntoDevTools`) · `react-devtools/OVERVIEW.md` (operations format, hook re-render inspection).

**OSS MCP prior-art (all MIT):**
`skylarbarrera/react-devtools-mcp` — `src/bridge.ts` (operations decoder, id-maps, correlation, `attachToExternal`), `src/headless-server.ts` (`addMessageListener`/`sendMessage` seam), `src/types.ts` (`Element`, `InspectedElement`, `DehydratedData`), `src/errors.ts`, `TOOLS.md` · `mcpc-tech/dev-inspector-mcp` — `packages/unplugin-dev-inspector/client/sourceDetector.ts` (fiber-walk + `data-insp-path`) · `ChakshuGautam/react-devtools-mcp` — `mcp-server/index.js` (POC baseline).
