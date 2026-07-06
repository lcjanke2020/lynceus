# Node.js Inspector session-mode split — design

> Design doc for Node.js Inspector support. It locked the architectural decisions before the implementation phases began. Companion to [`docs/design-notes.md`](./design-notes.md) — that captures v1 (browser-only); this captures the v1 → browser-plus-Node extension.
>
> **Status:** this design has since been implemented. The phase-by-phase sequencing below is preserved as design rationale. Implementation landed in seven phases; §8 lists them, and the body references them by number:
>
> - **Phase 1 — state refactor** (`SessionState.kind`, module split, `debugger.ts`, `capabilities.ts` skeleton, `attach_node`, `unsupported_target`, the `buildScriptParsedHandler` factory refactor)
> - **Phase 2 — Node source-map loader** (kind-aware `fetchMap`, `fs.readFile` tier)
> - **Phase 3 — capability gating** (full `TOOL_KIND_SUPPORT` population + `requireCapable` calls)
> - **Phase 4 — `launch_node`** (child-process plumbing, stdio capture)
> - **Phase 5 — L2 Node coverage** (fake-CDP Node mode)
> - **Phase 6 — L3 Node e2e** (Node Inspector fixture)
> - **Phase 7 — docs** (README / ARCHITECTURE updates)

## 1. Goal + non-goals

### Goal

Extend the existing browser-only debugger surface to **also** drive a Node.js process exposed via the V8 Inspector protocol (`node --inspect` / `node --inspect-brk`). Reuse the existing `Runtime` / `Debugger` / source-map / pause / breakpoint code paths where they're already target-agnostic; cleanly gate the surfaces that are browser-only (`Page`, `DOM`, `Input`, browser `Network`) so a Node session never silently appears to work and then fail half-way through a tool call.

### Non-goals (this design)

**This design is design-only — no code lands here.** Each item below names the implementation phase that ships the corresponding code:

- `launch_node` / `attach_node` — **Phase 1 (state refactor)** and **Phase 4 (`launch_node`)**.
- Capability-gating *mechanism* (`unsupported_target` error code, `requireCapable()` helper, `src/session/capabilities.ts` skeleton + `select_target` entry to protect itself from the state refactor) — **Phase 1**, alongside the state-refactor wave.
- Capability table *population* (`requireCapable(...)` calls in every browser-only tool, full per-tool kind matrix) — **Phase 3 (capability gating)**.
- L2 / L3 / L4 test additions — **Phase 5 (L2 Node coverage)** and **Phase 6 (L3 Node e2e)**.
- README / `ARCHITECTURE.md` updates — **Phase 7 (docs)**.
- Multiple concurrent debugger sessions (browser AND Node alive at once) — **future concurrent-session support**. This design keeps the existing "one active session" invariant; the `kind` field added here is what a future session map would key by.

## 2. `SessionState` shape

Today (`src/session/state.ts`), `SessionState` is browser-specific in two ways:

1. The `chrome: LaunchedChrome | null` field — typed to the chrome-launcher handle.
2. `SessionState.close()` (`src/session/state.ts`, called from the `close_session` tool via `closeSession()` in `src/session/browser.ts`) only kills the process when `chrome && !attached`.

Generalize both along a new `kind` axis. The `attached` boolean stays — it already encodes the "we launched this vs. borrowed it" distinction we need to mirror for Node.

```ts
import type { LaunchedChrome } from "chrome-launcher";
import type { ChildProcess } from "node:child_process";

export type SessionKind = "browser" | "node";

export type OwnedProcess =
  | { kind: "chrome"; handle: LaunchedChrome }
  | { kind: "node";   handle: ChildProcess };

class SessionState {
  kind: SessionKind = "browser";                  // NEW
  client: CDP.Client | null = null;
  ownedProcess: OwnedProcess | null = null;       // REPLACES `chrome: LaunchedChrome | null`
  chromePort: number | null = null;               // (renaming to `debuggerPort` is tempting but adds churn — defer)
  attached = false;                               // unchanged semantics: true when we did NOT launch

  // ...everything else (pause, console, network, scripts, breakpoints,
  // sessionHandlers, pauseOnExceptions, bpCounter) is unchanged.
}
```

`close()` becomes kind-agnostic:

```ts
async close(): Promise<void> {
  try {
    await this.client?.close().catch(() => {});
  } finally {
    if (this.ownedProcess && !this.attached) {
      try { this.ownedProcess.handle.kill(); } catch { /* ignore */ }
    }
    this.reset();
  }
}
```

Per [`src/session/README.md`](../src/session/README.md), the singleton `sessionState` and its `requireSession()` / `requirePaused()` accessors stay unchanged — every existing tool keeps compiling. The new `kind` field is set by the lifecycle entry point (Chrome lifecycle leaves it `"browser"`; Node lifecycle sets `"node"`).

### Deliberate vocabulary split: `SessionKind` vs. `OwnedProcess.kind`

The two unions don't share strings:

- **`SessionKind = "browser" | "node"`** is the user-facing concept — what *kind of debugging context* the session represents. Matches the existing error-message text in `src/util/errors.ts` (*"No browser session. Call launch_chrome…"*) and the `requires a browser session` phrasing of the new `unsupported_target` error (§4).
- **`OwnedProcess.kind = "chrome" | "node"`** tags the literal process handle: chrome-launcher's `LaunchedChrome` vs. Node's `ChildProcess`. It exists only so `close()` can dispatch `.kill()` correctly across the two handle types.

The asymmetry is deliberate. If a non-Chromium browser engine ever lands (Firefox via the WebKit/Gecko CDP shim, Edge with custom flags, etc.), `OwnedProcess` grows another variant (`{ kind: "firefox"; handle: … }`) without touching `SessionKind` or any tool-level capability gating — Firefox is still a *browser* session.

## 3. Module split

`src/session/browser.ts` today mixes three concerns that need separating before Node can share them:

| Concern | Used by | Target-agnostic? |
|---|---|---|
| `chrome-launcher` launch / `CDP.List`+`CDP()` attach / page-target selection / `Target.setAutoAttach` | Browser only | No |
| Enable `Runtime` + `Debugger` domains; wire `Debugger.scriptParsed` (via `attachScriptListener`) + `Debugger.paused/resumed` + `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` | Browser + Node | **Yes** |
| Enable `Page` + `DOM` + `Network` domains; wire `Network.*` events for the network ring buffer | Browser only | No |

### Extraction

Move the target-agnostic block into a new file **`src/session/debugger.ts`**:

```ts
// src/session/debugger.ts
export async function connectDebugger(
  client: CDP.Client,
  sessionId: string | undefined,
): Promise<void> {
  // 1. Wire Debugger + Runtime event handlers (the "target-agnostic" rows of
  //    today's wireDomainHandlers — scriptParsed via the script-parsed handler,
  //    Debugger.paused/resumed, Runtime.consoleAPICalled, exceptionThrown).
  // 2. Enable Runtime + Debugger domains:
  //      await client.Runtime.enable(sessionId);
  //      await client.Debugger.enable({}, sessionId);
}

export function disconnectDebugger(
  client: CDP.Client,
  sessionId: string,
): void {
  // Symmetric teardown — mirrors today's detachSession() body in browser.ts,
  // but only the Runtime+Debugger handlers. Browser-only handlers are removed
  // by a sibling browser-side helper.
}
```

The browser-only block stays in `browser.ts` as a sibling helper:

```ts
// src/session/browser.ts (after refactor)
async function enableBrowserDomains(client: CDP.Client, sessionId: string | undefined) {
  await swallow(client.Page.enable(sessionId));
  await swallow(client.DOM.enable({}, sessionId));
  await swallow(client.Network.enable({}, sessionId));
  // Plus: wire Network.* event handlers for the network ring buffer.
}
```

`connectToTarget()` (`browser.ts`) becomes a thin orchestrator:

```ts
async function connectToTarget(port, targetId, host?) {
  const client = await CDP({ port, host, target: targetId });
  sessionState.client = client;
  sessionState.currentTargetId = targetId;
  // Target.attachedToTarget / detachedFromTarget wiring stays here (browser-only).
  await connectDebugger(client, undefined);
  await enableBrowserDomains(client, undefined);
  try { await client.Target.setAutoAttach(...); } catch (e) { /* log */ }
}
```

The Node lifecycle's `attachNode()` mirrors this:

```ts
// src/session/node.ts — sketch
export async function attachNode(opts: { host?: string; port?: number }) {
  if (sessionState.client) throw alreadySession();
  const port = opts.port ?? 9229;
  // Node inspector exposes /json/list like Chrome; pick the first inspector target.
  const targets = await CDP.List({ port, host: opts.host });
  const client = await CDP({ port, host: opts.host, target: targets[0]!.id });
  sessionState.kind = "node";
  sessionState.client = client;
  sessionState.attached = true;
  sessionState.chromePort = port;
  await connectDebugger(client, undefined);
  // NO enableBrowserDomains. NO Target.setAutoAttach (Node has no child sessions).
  // Fire the entry pause for --inspect-brk targets; no-op for --inspect.
  // See §7 entry-pause contract for why this is here (and why Debugger.resume is NOT).
  await client.send("Runtime.runIfWaitingForDebugger");
}
```

The asymmetry (`Target.*` and `enableBrowserDomains` skipped for Node) is intentional and lives at the kind-specific lifecycle layer, not inside `connectDebugger`.

### Handler-registry aggregation

Today `wireDomainHandlers` (`src/session/browser.ts`) builds one `registered: HandlerEntry[]` array and writes it wholesale at the bottom: `sessionState.sessionHandlers.set(sessionId ?? ROOT_SESSION_KEY, registered)` (`browser.ts`). That works because *one* function writes the map per session.

Post-split, **both** `connectDebugger` and `enableBrowserDomains` register handlers. If each issued its own `.set(...)`, the second call would clobber the first's array and `detachSession()` (`src/session/browser.ts`) would leak the earlier listeners — source-map / pause / console handlers from `connectDebugger` would survive past detach.

Resolution: introduce a shared helper that **attaches AND tracks in one call**, used by both `connectDebugger` and `enableBrowserDomains`. The single-call shape is deliberate — a tracking-only helper would let an implementer call `registerHandler(...)` without the matching `client.on(...)` and silently drop events, or attach via `client.on(...)` without tracking and leak listeners on detach.

```ts
// src/session/state.ts — new helper next to the existing accessors
export function registerHandler(
  s: SessionState,
  client: CDP.Client,
  sessionId: string | undefined,
  event: string,
  handler: (...args: any[]) => void,
): void {
  // Single entry point: attach the listener AND record it for teardown.
  // Doing both here makes it impossible to drift the two halves out of
  // sync (handler that fires but never gets removed, or handler tracked
  // but never wired).
  client.on(event as any, handler as any);
  const key = sessionId ?? ROOT_SESSION_KEY;
  const list = s.sessionHandlers.get(key) ?? [];
  list.push({ event, handler });
  s.sessionHandlers.set(key, list);
}
```

`connectDebugger` calls `registerHandler` for `Debugger.scriptParsed`, `Debugger.paused`, `Debugger.resumed`, `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`. `enableBrowserDomains` calls it for the four `Network.*` events. `detachSession()` is unchanged — it already iterates the full per-session list (`browser.ts`) and calls `removeListener` on every entry, which still works when the list came from multiple registrars.

**The script-parsed listener needs a co-refactor.** The pre-Node `attachScriptListener` (`src/sourcemap/loader.ts`) calls `client.on("Debugger.scriptParsed", handler)` internally and returns the handler — the older "attach + return for tracking" pattern that the pre-Node `wireDomainHandlers` (`src/session/browser.ts`) accommodates by track-only-pushing the returned handler without re-attaching. That pattern collides with the new attach-AND-track `registerHandler`: passing `attachScriptListener(...)`'s return value into `registerHandler(...)` would double-attach the listener; skipping `registerHandler` for this one event would leak the handler on detach.

Phase 1 resolves this by refactoring `attachScriptListener` into a **pure factory** that builds and returns the handler without calling `client.on`:

```ts
// src/sourcemap/loader.ts — post-refactor
export function buildScriptParsedHandler(
  client: CDP.Client,
  store: ScriptStore,
  sessionId: string | undefined,
): (params: any, eventSessionId?: string) => void {
  return (params: any, eventSessionId?: string) => {
    // ...existing body of attachScriptListener's inner handler, unchanged...
  };
}
```

`connectDebugger` then wires it uniformly via the single attach pathway:

```ts
registerHandler(
  s,
  client,
  sessionId,
  "Debugger.scriptParsed",
  buildScriptParsedHandler(client, sessionState.scripts, sessionId),
);
```

One attach pathway, no special-case. Renaming `attachScriptListener` → `buildScriptParsedHandler` is part of the Phase 1 diff; the only other call site is `wireDomainHandlers` (`browser.ts`), which `connectDebugger` is replacing anyway.

### `select_target` / `switchTarget` — browser-only by construction

`switchTarget()` (`src/session/browser.ts`) and its `select_target` tool wrapper (`src/tools/session.ts`) read `sessionState.chromePort` + `sessionState.chrome`, call `CDP.List`, then run `connectToTarget` — every step is browser-specific. After the §2 refactor, the `chrome` field is gone (folded into `ownedProcess`), so calling `switchTarget` on a Node session would either crash on field access *or*, worse, succeed at running Chrome-page reconnect logic against a Node-Inspector target.

The design commits to gating `select_target` via the capability table introduced in §4 — `select_target: new Set(["browser"])`. Phase 1 wires that entry as soon as the helper exists (it's the one entry Phase 1 needs to ship for self-protection; Phase 3 fills out the rest of the table).

## 4. Capability-gating mechanism

### Error

`src/util/errors.ts` defines `class ToolError extends Error { code, message }`; the tool wrapper (`src/tools/_register.ts`) turns thrown `ToolError`s into the wire envelope `{ error: code, message: msg }`. Existing codes: `no_session`, `not_paused`, `already_session`, fallback `internal_error`.

Add a new code following the same pattern:

```ts
// src/util/errors.ts
export const unsupportedTarget = (tool: string, kind: SessionKind) =>
  new ToolError(
    "unsupported_target",
    `Tool ${tool} requires a browser session (current session is ${kind})`,
  );
```

The message is intentionally agent-readable: it states the tool name AND the current kind so the model can recover (e.g. by closing and relaunching as the other kind).

### Capability table + helper

Add a new file **`src/session/capabilities.ts`**:

```ts
import type { SessionKind } from "./state.js";

// Browser kind is the default — only tools that REJECT a kind need to be listed.
// The table is consulted by requireCapable(); missing entries are permissive.
// Phase 1 ships this file with the one entry below (self-protection during the
// state refactor). Phase 3 populates the real table (every browser-only tool
// from src/tools/dom.ts, parts of nav.ts, the browser-network body tools,
// target tools, screenshot).
export const TOOL_KIND_SUPPORT: Record<string, ReadonlySet<SessionKind>> = {
  // Phase 1 ships only the self-protection entry — without this, the state
  // refactor's removal of `sessionState.chrome` would crash switchTarget on a
  // Node session. Phase 3 fills out the rest.
  select_target: new Set(["browser"]),
};
```

Add a new helper next to `requireSession`/`requirePaused` in `src/session/state.ts`:

```ts
export function requireCapable(s: SessionState, tool: string): void {
  const allowed = TOOL_KIND_SUPPORT[tool];
  if (!allowed) return;            // permissive when unlisted — Phase 3 tightens
  if (!allowed.has(s.kind)) throw unsupportedTarget(tool, s.kind);
}
```

Each browser-only tool gains a one-liner — added in Phase 3, not here:

```ts
async (input) => {
  const s = requireSession();
  requireCapable(s, "click");
  // ...existing body unchanged...
}
```

### Ownership

**This design is design-only — no code lands here.** Implementation splits across two phases:

| Component | Phase | Why |
|---|---|---|
| `unsupportedTarget()` factory + `unsupported_target` code in `src/util/errors.ts` | **Phase 1** | The state refactor needs to throw it from `select_target` immediately |
| `requireCapable()` helper in `src/session/state.ts` | **Phase 1** | Same — needed for self-protection |
| `src/session/capabilities.ts` file with skeleton table (`select_target` only) | **Phase 1** | Same |
| Full capability-table population + `requireCapable(...)` calls in every browser-only tool | **Phase 3** | The actual gating wave |

Until Phase 3 lands, the table contains only `select_target` — so existing browser-session tools keep working unchanged, and a Node session would let most browser-only tools fall through and fail with their own raw CDP errors. That gap is expected — the sequencing puts Phase 3 before any user-facing Node demo.

## 5. Source-map loading for Node

`src/sourcemap/loader.ts` (`loadSourceMap` + `fetchMap`) is two-tier today:

1. **Primary:** CDP `Network.loadNetworkResource` — uses the page's network stack (cookies / auth / dev-server middleware). Requires `Network` + optionally `Page` domains.
2. **Fallback:** Node `fetch()` — works for plain localhost HTTP, loses page context.
3. Inline `data:` URIs handled separately (`loader.ts`, via `decodeDataUri`).

Node Inspector:
- Has **no `Network` domain** — the primary tier always fails.
- Source maps typically live on disk: `Debugger.scriptParsed.url` is `file:///abs/path/file.js`, `sourceMappingURL` is usually `./file.js.map` (relative to the script URL) or a `data:` URI.

Make the loader **kind-aware** by threading `SessionState` (not just URL) into `fetchMap`:

```ts
// signature change
async function fetchMap(s: Session, url: string, sessionId: string | undefined): Promise<string>
```

Tier order by `s.kind`:

| Kind | 1st tier | 2nd tier | 3rd tier |
|---|---|---|---|
| `"browser"` | `Network.loadNetworkResource` (unchanged) | Node `fetch()` | — |
| `"node"` | `fs.readFile()` for `file://` URLs (resolve via `url.fileURLToPath`) | Node `fetch()` for HTTP URLs (rare in Node — possible for sourcemaps pointing at dev-server-built bundles) | — |

`data:` URIs work in both kinds via the existing `loadSourceMap` path (`loader.ts`), no change.

Why pass the whole `SessionState` rather than just `kind`: it costs nothing today and lets us add per-session caching / source-map disk paths / tsconfig-derived rootDir later without another signature break. Either is defensible — pass-the-whole-thing is the recommended call.

Open implementation question (deferred to Phase 2): when a Node script's `Debugger.scriptParsed.url` is a `file://` and the `sourceMappingURL` is relative, `new URL(sourceMapURL, scriptUrl)` already resolves correctly to a `file://` URL — `fs.readFile(fileURLToPath(resolved))` then works. Confirm against a real `node --inspect` of a tsc-compiled source with `sourceMap: true`; document anything that surprises.

## 6. Module-by-module change summary

This design is markdown-only — no source files change here. Implementation lands per the table below:

| File | Lands in | What changes |
|---|---|---|
| `src/session/state.ts` | Phase 1 | `SessionState` gains `kind`, `ownedProcess`; `chrome` field removed; new `registerHandler()` + `requireCapable()` helpers next to `requireSession()` / `requirePaused()` |
| `src/session/browser.ts` | Phase 1 | `enableDomains`/`wireDomainHandlers` split: target-agnostic half moves to `debugger.ts`; browser-specific half stays as `enableBrowserDomains` + browser event wiring. Handler registration switches to `registerHandler()` |
| `src/session/debugger.ts` *(new)* | Phase 1 | `connectDebugger` / `disconnectDebugger` — shared between browser + Node |
| `src/session/node.ts` *(new)* | Phase 1 / Phase 4 | `attachNode` (Phase 1), `launchNode` (Phase 4) |
| `src/session/capabilities.ts` *(new)* | Phase 1 (skeleton) → Phase 3 (populated) | Skeleton with `select_target: ["browser"]` self-protection entry; Phase 3 adds the full per-tool kind matrix |
| `src/util/errors.ts` | Phase 1 | `unsupportedTarget()` factory + `unsupported_target` code |
| `src/sourcemap/loader.ts` | Phase 1 + Phase 2 | **Phase 1:** `attachScriptListener` → `buildScriptParsedHandler` pure-factory refactor (no internal `client.on`); **Phase 2:** `fetchMap` gains `Session` arg, kind-aware tier order, `fs.readFile()` tier added |
| `src/tools/*.ts` | Phase 3 | Browser-only tools gain a one-line `requireCapable(s, "<tool>")` call |
| `docs/node-session-design.md` *(this file)* | **This design** | — |

## 7. Worked example — full Node debug flow

End-to-end transcript walking through one full Node debug cycle and naming the existing browser-side code path each step reuses. This is the contract the implementation phases build against.

### `--inspect-brk` entry-pause contract

`node --inspect-brk` parks the V8 isolate at startup, waiting for the inspector. Two CDP calls matter for the contract:

1. **`Runtime.runIfWaitingForDebugger`** — tells V8 it's OK to start running. For `--inspect-brk` targets, V8 then emits the entry `Debugger.paused`. For `--inspect` targets (runtime not waiting), this is a no-op.
2. **`Debugger.resume`** — releases the process from any pause, including the entry pause.

**The design commits to calling `Runtime.runIfWaitingForDebugger` inside `attach_node` (after `Debugger.enable`), but NOT calling `Debugger.resume`.** The entry pause flows through the existing pause machinery; the agent observes it, installs breakpoints, calls `resume()` to release the process, then `wait_for_pause()` for the target breakpoint.

Two reasons for surfacing the pause rather than auto-running past it:

1. **Composability.** Installing breakpoints from the entry pause is the natural full-cycle flow. The script catalogue is populated as static ESM imports parse around startup, so breakpoints in eagerly-imported modules bind reliably from the entry pause. (See §9 for the CJS / lazy-import caveat.)
2. **Reuse.** The entry pause is just another `Debugger.paused` event; the existing `PauseTracker` (`src/session/pause.ts`) handles it without modification.

Why we DO call `runIfWaitingForDebugger`: empirically verified on Node v24.13.1 (PR-review probe, 2026-05-20). Without it, V8 never fires `Debugger.paused` after `Debugger.enable`, and any subsequent `Debugger.resume` returns *"Can only perform operation while paused"*. The call is the trigger that makes the entry pause materialize at all.

**`reason` is opaque — implementers must not assert specific values.** Node emits `Debugger.paused.reason` strings outside the Chromium devtools-protocol type — empirically `"Break on start"` rather than the union's `"other"`. The transcript below uses opaque placeholder text (`reason: <V8 break-on-start>`). Practical fallout:

- `PauseState.reason` should be typed `string`, not narrowed to Chromium's union.
- Phase 5 (L2 Node coverage) should NOT assert specific `reason` strings.
- Breakpoint detection must drive off `hitBreakpoints` (CDP) or the tool summary's `hit_breakpoint_ids`, not a `reason === "breakpoint"` check — the checked-in devtools-protocol type doesn't even include `"breakpoint"` as a `reason` value.

For `node --inspect` (no `-brk`), `runIfWaitingForDebugger` is a no-op and there's no entry pause; the first `wait_for_pause` blocks until a user-installed breakpoint hits. Both modes share one `attach_node` implementation. The worked example below uses `--inspect-brk` because it exercises the entry-pause case.

### Transcript

**Setup.** User runs `node --inspect-brk dist/server.js`. Node prints `Debugger listening on ws://127.0.0.1:9229/…` and waits for an attach.

#### Step 1 — `attach_node({ port: 9229 })`

| Sub-step | Code path |
|---|---|
| `if (sessionState.client) throw alreadySession()` | Same guard as `src/session/browser.ts, 110` |
| `CDP.List({ port: 9229 })` → first inspector target | Same as `attachChrome` (`src/session/browser.ts`) |
| `CDP({ port, target: targets[0].id })` | Same client API as `connectToTarget` (`src/session/browser.ts`) |
| Set `kind = "node"`, `attached = true`, `chromePort = port` | New (per §2) |
| `connectDebugger(client, undefined)` — enables `Runtime` + `Debugger`, wires `scriptParsed` / `paused` / `resumed` / `consoleAPICalled` / `exceptionThrown` via `registerHandler()` | **Refactored** from `src/session/browser.ts, 234–245, 247–357` |
| **SKIP** `enableBrowserDomains` and `Target.setAutoAttach` | Node has no `Page`/`DOM`/`Network` domains and no child sessions |
| `client.send("Runtime.runIfWaitingForDebugger")` | **New, Node-only** (per the contract subsection above) — fires the entry pause for `--inspect-brk`; no-op for `--inspect` |

Returns `{ targetId, url: "" }`. For `--inspect-brk` targets, V8 fires `Debugger.paused` shortly after `runIfWaitingForDebugger` — the `PauseTracker` handler records it asynchronously, so the agent's first `wait_for_pause` returns the entry pause (whether it had already landed by the time `wait_for_pause` is called, or arrives during the wait). For `--inspect` targets the process is already running; there's no entry pause.

#### Step 2 — `wait_for_pause()` (entry pause)

| Sub-step | Code path |
|---|---|
| `requireSession()` then `pause.waitForPause(timeout)` | `src/session/pause.ts` `waitForPause()`, called from `src/tools/execution.ts` (unchanged) |
| `onPaused` records the entry pause when V8 fires it (triggered by `runIfWaitingForDebugger` in Step 1); the waiter resolves once the event arrives | `wireDomainHandlers` → `onPaused` (`src/session/browser.ts`), post-refactor moved into `connectDebugger` |

Returns `{ reason: <V8 break-on-start, opaque>, callStack: [{file: "src/index.ts", line: 1, …}], … }` — V8 parks at the first executable line of the entry module. Per the contract subsection, the `reason` value is opaque (Node emits non-Chromium strings); implementers should not branch on it. At this point no user breakpoints exist yet.

#### Step 3 — `set_breakpoint({ file: "src/handlers.ts", line: 42 })`

Identical to today, because every code path it touches is already kind-agnostic:

| Sub-step | Code path |
|---|---|
| `requireSession()` | `src/session/state.ts` (unchanged) |
| `mapOriginalToGenerated(s.scripts, "src/handlers.ts", 42, 0)` returns `[{ scriptId, scriptUrl, sessionId: undefined, lineNumber: 41, columnNumber: 0 }]` | `src/sourcemap/store.ts` — already operates on the compound-keyed `ScriptStore` populated by `connectDebugger`'s `scriptParsed` handler |
| For each binding, find the set of CDP flat-session IDs from `sessionHandlers` and call `client.send("Debugger.setBreakpointByUrl", ..., sid)` | Unchanged. For Node there's exactly one entry (the root) since there are no auto-attached children. |
| Store `BreakpointRecord` and return `{ id, resolvedLocations }` | Unchanged (`src/session/state.ts`) |

Source-map loading along the way: this transcript assumes the entry module statically imports `handlers.js` (ESM `import` at the top of `dist/server.js`). Static imports are parsed eagerly during module-loading, before V8 hits the entry pause, so `dist/handlers.js` is in the `ScriptStore` by the time `wait_for_pause` returns — but the **source-map consumer may not be**. The script-parsed handler (`src/sourcemap/loader.ts`) fires `void loadSourceMap(...)` as fire-and-forget; the actual `fs.readFile` (Node tier per §5) + `SourceMapConsumer` parse complete asynchronously, after `Debugger.scriptParsed` and after `Debugger.paused`. A timing probe showed: scripts and the entry pause arrive at the same wall-clock tick; map reads land a few ms later.

**Implication:** an immediate `set_breakpoint` after the entry pause can return `no_mapping` even when `dist/handlers.js` *is* in `ScriptStore` — its `consumer` field is still `undefined` because the async map load hasn't completed. This is **the same race that exists today on the browser side**, masked there by `navigate` typically resolving after map loads complete. See §9 for the loader-readiness open question — Phase 1 / Phase 2 own the resolution (recommended direction: a short bounded internal wait inside `mapOriginalToGenerated` or `set_breakpoint`'s pre-flight, so agents don't have to poll `list_scripts(mapped_only: true)` themselves).

For CJS or lazy-loaded modules that haven't been required yet at the entry pause, the *script* isn't in `ScriptStore` at all — different failure mode, also `no_mapping`. See §9 for the pending-breakpoint open question.

#### Step 4 — `resume()` (release the process)

Standard `resume()` tool: `client.send("Debugger.resume", ..., sid)`. The process runs from the entry point. No code change from today.

#### Step 5 — agent triggers the breakpoint

Out of band: the Node process hits the breakpoint when something invokes the handler at `src/handlers.ts:42` (e.g. an HTTP request the agent makes via `fetch`, or a `setImmediate`-driven test harness, or some other external stimulus). The agent then issues:

#### Step 6 — `wait_for_pause()` (target breakpoint)

Same machinery as Step 2, but now `hitBreakpoints` lists the CDP breakpoint ID bound in Step 3 (and the tool summary's `hit_breakpoint_ids` carries the user-facing ID). Implementers should drive breakpoint detection off `hitBreakpoints` / `hit_breakpoint_ids`, not a `reason === "breakpoint"` check — `"breakpoint"` isn't in the checked-in devtools-protocol `Debugger.paused.reason` union, and Node's reason values are opaque (per the contract subsection). The summarized pause includes the TS-mapped frame via `mapCdpToOriginal` (`src/sourcemap/store.ts`) — already source-map-aware.

#### Step 7 — `get_scope({ frame_index: 0, scope_type: "local" })`

Unchanged. `requirePaused()` (`src/session/state.ts`), then `Runtime.getProperties` on the scope's `objectId`. Both are Node-supported domains. The `objectId` round-trips with the implicit root `session_id` per [`src/session/README.md`](../src/session/README.md) §`session_id` provenance.

#### Step 8 — `step_over()`

Unchanged. `requirePaused()`, `client.send("Debugger.stepOver", ..., sid)`, then `pause.waitForPauseOrResume(timeout)`. The fast-step entry-guard race (`src/session/pause.ts` `waitForPauseOrResume` comment) applies identically — CRI's batched event delivery doesn't care which kind of target produced the pause.

#### Step 9 — `close_session()`

`SessionState.close()` (`src/session/state.ts`, post-refactor). Closes the CDP client; `ownedProcess === null && attached === true` means we don't kill anything. The user's Node process stays running.

**Tools that would have failed in this flow if not gated** (and that Phase 3 hard-blocks): `click`, `type`, `query_selector`, `get_element_html`, `screenshot`, `navigate`, `reload`, `get_url`, `get_network_requests` (Node inspector has no `Network`), and `select_target` (gated in Phase 1 for self-protection — see §3). Reading the *console* ring buffer still works — `Runtime.consoleAPICalled` exists in Node and is wired by `connectDebugger`.

## 8. Implementation sequencing

This design locked the architecture; implementation then landed in seven phases (plus this design):

1. **This design** — design only, no code.
2. **Phase 1 — state refactor** — split `state.ts`, create `debugger.ts`, create `capabilities.ts`, implement `attach_node`. One PR. The load-bearing phase: it lands the `kind` field, the module split, and the first real Node `attach_node`. Until it merges, none of the rest can start meaningfully.
3. **Phase 2 — Node source-map loader** — kind-aware `fetchMap` with the `fs.readFile()` tier.
4. **Phase 3 — capability gating** — populate the capability table; add `requireCapable` calls to every browser-only tool.
5. **Phase 4 — `launch_node`** — child-process plumbing, stdout/stderr capture.
6. **Phase 5 — L2 Node coverage** — fake-CDP coverage for Node mode.
7. **Phase 6 — L3 Node e2e** — Node Inspector e2e fixture.
8. **Phase 7 — docs** — `README.md` removes Node from "Out of scope"; `ARCHITECTURE.md` gets browser/Node lanes.

## 9. Open questions (resolved during implementation)

- **Node child sessions.** Node Inspector does support `Worker`-domain auto-attach for worker threads. v1 explicitly punts on Node workers (single root session only). When Phase 1 landed, the follow-up was to confirm no `Target.attachedToTarget` events fire on a Node session — if they do, it means deciding between (a) honoring them via the existing child-attach path, or (b) ignoring them with a logged warning. Recommended posture: warn-and-ignore for v1; revisit if a real user case hits it.
- **`launch_node` stdin/stdout/stderr policy.** Phase 4 keeps stdio handling to startup diagnostics and pipe draining so the child cannot block on a full pipe. A durable pull-based stdout/stderr buffer is tracked separately (the durable Node-output buffer); it stays separate from the console buffer, which is for `console.*` calls captured via `Runtime.consoleAPICalled`.
- **`sourceMappingURL` resolution for ESM Node + `--enable-source-maps`.** Node 20+ resolves source maps itself when `--enable-source-maps` is set. We don't need that; we have our own loader. But Phase 2 must verify that the `Debugger.scriptParsed.sourceMapURL` field is still populated when the flag is on (it should be — the flag is for Node's *own* error-trace remapping, not the inspector). If it isn't, the loader needs a `Debugger.getScriptSource` + inline-map-comment fallback.
- **TypeScript Node binaries (`tsx`, `ts-node`, `bun`).** These compile in-memory and may emit synthetic `node:` URLs or memory-only source maps. v1 contract: works against compiled JS + sourcemap on disk; in-memory loaders are best-effort. Phase 6's L3 fixture must use the disk path.
- **Pending breakpoints in not-yet-parsed Node modules (CJS / lazy imports).** `Debugger.setBreakpointByUrl` natively supports pending breakpoints — it returns a `breakpointId` even when no script matches the URL yet, and binds lazily when `Debugger.scriptParsed` fires. However, `set_breakpoint` resolves through `mapOriginalToGenerated` (`src/sourcemap/store.ts`), which depends on the source map already being in `ScriptStore`. A review probe (Node v24.13.1) confirmed: static ESM imports all land before the entry pause, but CJS / lazy modules don't — `require('./handlers')` hasn't run yet, so the script isn't parsed and `set_breakpoint` returns `no_mapping`. **v1 scope:** Phase 6's L3 fixture uses compiled ESM with static imports (the case that works end-to-end from the entry pause). **Follow-up:** a pending-breakpoint code path that accepts a hint URL (or scans `tsconfig.outDir`) and defers source-map resolution until `scriptParsed` — a clean sibling of Phase 2 / Phase 3, out of scope here.

- **Source-map load race at the entry pause.** A subtler failure mode than the CJS one above, in the *static-ESM happy path*. The script-parsed handler (`src/sourcemap/loader.ts`) starts `loadSourceMap()` as fire-and-forget (`void loadSourceMap(...)`); `Debugger.scriptParsed` puts the script into `ScriptStore` synchronously, but the `consumer` field is `undefined` until the async map read + parse completes. A second probe (Node v24.13.1) measured the window: `scriptParsed` and `Debugger.paused` arrive at the same tick; map reads complete a few ms later. So an agent that calls `set_breakpoint` immediately after `wait_for_pause` returns the entry pause can hit a `no_mapping` even though the script is fully tracked. The same race exists today on the browser side but is typically masked by `navigate(wait:"load")` blocking past the map load. **Recommended resolution — land in Phase 1:** add a short bounded internal wait inside `mapOriginalToGenerated` (or as a pre-flight inside `set_breakpoint`) — when the script is in `ScriptStore` but `consumer` is `undefined`, poll for up to ~500 ms before returning `no_mapping`. Keeps the public contract simple (no agent-visible polling) and resolves both the Node entry-pause case and any latent browser-side races. **Why Phase 1 specifically:** Phase 1's `attach_node` is the first surface where this race fires in earnest — the browser side masks it incidentally via `navigate(wait:"load")` blocking past map loads, but Node's entry pause has no analogous barrier, so the race is exposed the moment `attach_node` returns. Deferring would mean Phase 1's contract tests have to encode the workaround. Workaround for any code written before this lands: agent retries `set_breakpoint` with backoff, or polls `list_scripts(mapped_only: true, url_includes: "<file>")` until `has_map` is `true`.

These didn't block the design — they were flagged here so the right implementation phase picked them up.
