# lynceus Test + Eval Plan

## Context

`lynceus` is an MCP server (Node 20+, TS, vitest) wrapping Chrome DevTools Protocol and exposing **36 tools** across **9 module groups** (`session`, `nav`, `source`, `breakpoints`, `execution`, `inspect`, `console`, `network`, `dom` — one per file in `src/tools/`) to LLM agents as a TypeScript-aware frontend debugger. After two reviewer-iteration rounds (Codex + ultrareview), the *implementation* is solid, but the **test surface is shallow**:

- 5 vitest files (~373 LOC) cover only pure data structures: source-map decoding/normalization/translation (`src/sourcemap/{loader,normalize,store}.test.ts`), `RingBuffer` (`src/session/buffers.test.ts`), `PauseTracker` (`src/session/pause.test.ts`).
- `scripts/smoke.mjs` only verifies the MCP `initialize` + `tools/list` handshake — never touches CDP.
- **Zero coverage on the 36 tool implementations themselves** — every CRI wire contract, every error-code path, every multi-session route is untested.
- `examples/sample-app/` exists with one intentional bug (`computeStep()` returns 2; `handlers.ts:12`) but is **manual-only** — no automated browser test, no agent eval.
- **No CI** (no `.github/workflows/`).

This plan closes those gaps with a four-layer pyramid plus an LLM-agent eval suite, all gated in CI. Day-1 primary environment is **Linux ARM64 + Chromium**; Linux x86_64 covers both Chromium and Chrome; Windows is a deliberate follow-on once a self-hosted nightly runner is provisioned.

---

## Layered design

### Layer 1 — Unit (expand existing pure-data pattern)

Add to existing files; no new infrastructure.

- **`src/util/format.test.ts`** *(new)* — `previewRemoteObject` and `truncate` (consumed by `evaluate`, `get_scope`, `get_object_properties`, `get_console_logs`). Cover `unserializableValue` (NaN/Infinity/-0), `subtype: "null"`, multiline-description functions, array/object preview overflow, exact-boundary truncation. Without this, a regression to JSON-stringification would silently corrupt console buffering.
- **`src/tools/breakpoints.test.ts`** *(new)* — exercise `buildConditionExpression` (currently internal at `src/tools/breakpoints.ts:149`; **export it** for testing). Cases: condition only, logMessage only, both combined, `{expr}` interpolation, embedded quotes survive `JSON.stringify`. This expression is `Runtime.evaluate`'d inside the page — getting it wrong is sandbox-relevant.
- **`src/tools/execution.test.ts`** *(new)* — exercise `matchUserBreakpoints` (export from `src/tools/execution.ts:137`). Cases: same `cdpId` bound in two sessions resolves only the paused session's binding; root + child collision; empty `hit`.
- **`src/sourcemap/store.test.ts`** *(extend)* — empty `consumer.sources`, missing `sources` field, `findByOriginalSource` with multiple candidates, `clear()` calls `consumer.destroy()` on every entry.
- **`src/session/buffers.test.ts`** *(extend)* — `update()` against empty buffer; `query` with `since > nextSeq`; `seq` correctness across capacity-boundary `update` paths.
- **`src/session/pause.test.ts`** *(extend)* — two concurrent `waitForPause` waiters resolved by one `onPaused`; `waitForPauseOrResume` race where pause + timeout fire in same tick.

Estimated **~250–350 LOC**, all <100ms.

### Layer 2 — Tool contract tests with a fake CRI

This is the **highest-leverage gap** — every one of the 36 tools is currently dark.

**Injection seam (verified).** `sessionState.client` is a public `CDP.Client | null` field on a singleton (`src/session/state.ts:31, 102`). `getSession()` only checks `client` truthiness (`state.ts:104`). Tests just assign `sessionState.client = fake` and the rest of `sessionState` (`pause`, `console`, `network`, `scripts`, `breakpoints`) works as normal. The single static-import surface is `CDP.List` (used by `attachChrome` in `src/session/browser.ts:61`) — stub via `vi.mock("chrome-remote-interface")`. No production code change required for the seam itself.

**Fake CRI (`test/fake-cdp.ts`, new).** A builder producing a `Client`-shaped object. Public surface, fully typed, before any per-tool tests are written:

1. **`send(method, params, sessionId?) → Promise<unknown>`** — backed by a method registry. Default registry returns `{}`; tests override per-method via `fake.respond(method, fn)`. The fn receives `(params, sessionId)` and returns either the response value or a `{ result, sideEffects: [...] }` shape (see #5).
2. **Domain shorthand accessors** (`Runtime.enable`, `Debugger.*`, `Page.*`, `DOM.*`, `Network.*`, `Target.*`, `IO.*`) implemented as thin shims over `send` so production `wireDomainHandlers` registers normally.
3. **EventEmitter-backed `on/removeListener`** — the fake exposes a `fake.emit(event, params, sessionId?)` test helper. Critically, the `flatten:true` auto-attach contract (`src/session/browser.ts:117–127`) means session events arrive on the **root socket with `eventSessionId` as a second argument** — the fake's `emit` mirrors this exact shape, or the production guard `eventSessionId !== sessionId` is silently bypassed. Subscribers registered with one argument receive `(params)`; subscribers registered with two arguments receive `(params, sessionId)`.
4. **`close()`** — no-op resolving promise.
5. **`onSend(method, hook)` — synchronous side-effect hook fired *when `send()` is called*, before any code awaiting `send()`'s result observes it.** This is how the fake supports the **auto-attach replay** invariant called out in *Critical gotchas → Auto-attach replay*: a test seeding two pre-existing children sets `fake.onSend("Target.setAutoAttach", () => { fake.emit("Target.attachedToTarget", child1); fake.emit("Target.attachedToTarget", child2); })` so production handlers registered via `client.on("Target.attachedToTarget", ...)` *before* the awaited `send()` see hook-emitted events inline with the response, exactly matching real Chrome's batch-enumeration behavior. **Critical:** the hook runs in the `send()` call body, before the Promise it returns is constructed — NOT via `setImmediate` or microtask deferral. Without this synchronicity the pause-race regression (`pause.ts:75`) is silently masked.
6. **`fake.seedScript(opts)` macro** — fires a single `Debugger.scriptParsed` event with the `sourceMapURL` populated as a *field* on the event (CDP fires one event per script; the source-map URL is part of the event payload, not a separate event). Wired into the registered script handler at `attachScriptListener` (`src/session/browser.ts:209`). Takes `{scriptId, url, sourceMapURL?, sessionId?}`. Per-tool tests that need source-map state call this once in arrange instead of re-deriving the event shape per file.
7. **`fake.fireNetworkLifecycle(reqId, opts)` macro** — chains `Network.requestWillBeSent` → `Network.responseReceived` → `Network.loadingFinished` (or `loadingFailed`) in the right order with the right field shapes for the `RingBuffer.update` flow at `browser.ts:252–301`. Takes `{url, type?, status?, mimeType?, durationMs?, failed?, sessionId?}`. Without this macro, every network-tool test re-encodes the lifecycle and tests will diverge on field names.
8. **`fake.makePauseState(opts)` factory** — returns a `PauseState` shape compatible with `pause.onPaused(...)` for tests that need to start in a paused state without driving the full attach + scriptParsed + setBreakpoint + emit("Debugger.paused") chain. Default: single TS-mapped frame at `handlers.ts:7`, one local scope, one `count` variable.

The fake is **typed against `CDP.Client`** (subset that production actually consumes — about 12 domain shorthand methods + `send`/`on`/`removeListener`/`close`); strict-null-checks on, no `any`. Tests assigning `sessionState.client = fake` get type errors if production starts using new methods, surfacing fake-fidelity gaps automatically.

**Per-tool test pattern.** For each tool in `src/tools/*.ts`, three classes of test:

1. *Happy path.* Prime fake state (e.g. for `get_call_stack`, call `pause.onPaused(...)` with a synthetic `PauseState`), invoke the tool's handler, assert JSON shape and that `fake.send` was called with the right method + `sessionId`.
2. *Each documented error code.* `no_session` (don't set `sessionState.client`), `not_paused` (`pause.reset()`), `no_mapping` (empty `ScriptStore`; since GH #37 the message distinguishes unknown file — echoing the mapped source paths — from a mapped file whose line has no generated code, from an explicit column nothing maps at/after, and from maps not (fully) loaded yet), `not_found` (DOM tools when `DOM.querySelector` returns `nodeId: 0`), `bad_frame` / `no_scope` (single-frame pause), `missing_arg` (`get_element_html` with neither arg), `already_session` (set `client` then call `launchChrome`).
3. *Session routing.* For every tool taking `session_id` (`get_object_properties`, `get_script_source`, `get_request_body`, `get_response_body`, `pause`), assert `fake.send` saw `sessionId === undefined` for omitted/null and `sessionId === "SW1"` for a string. This is the regression most likely to recur — half the comments in `src/tools/inspect.ts` and `src/tools/network.ts` are about it.

**Handler access — `captureTools()` for per-tool L2 tests; `InMemoryTransport` reserved for the contract test.** The implementation chose a **third option** beyond the two originally documented (InMemoryTransport vs `getRegisteredHandlers()` debug helper): `test/handler-registry.ts` exports a `captureTools(register)` helper that builds a fake `McpServer` recording each `(name, schema, handler)` registration into a `Map`. Per-tool tests invoke `tools.get(name)!.handler(input)` directly. This avoids both leaking a `getRegisteredHandlers()` debug export into `src/server.ts` AND reaching into `McpServer._registeredTools` (a private field, brittle across SDK minor versions). The `captureTools` approach is what each `test/tools/*.test.ts` actually uses.

**`InMemoryTransport` is reserved for the single contract test** (`test/contract/tool-registration.test.ts`). The MCP SDK ships `InMemoryTransport` at `@modelcontextprotocol/sdk/inMemory.js` (verified — file present in `node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js`). The contract test builds the server with `buildServer()` and drives it through a paired `InMemoryTransport.createLinkedPair()` + a `Client` from `@modelcontextprotocol/sdk/client/index.js`, exercising the **full** path (registration → schema validation → handler → `_register.ts` error envelope at `src/tools/_register.ts:21–35`). That's the only thing only InMemoryTransport can validate — it's NOT duplicated per-tool. (Earlier rev of this section preferred InMemoryTransport for per-tool tests; rev 5 fold corrected that to record what the implementation actually chose.)

If `captureTools()` ever proves insufficient for a future test pattern, the still-available fallback is the `getRegisteredHandlers(server)` debug helper that would tap `McpServer.registerTool` at registration time. Not currently in use; documented here as the escape hatch.

**Bonus: contract test (`test/contract/tool-registration.test.ts`).** Drive `buildServer()` through `InMemoryTransport`, call `tools/list`, and for each returned `Tool`: (a) assert `description` is non-empty, (b) assert `inputSchema` is present and well-formed (`type: "object"`), (c) verify exactly the documented set of tool names is registered (bidirectional set-equality check — catches both missing AND stale-renamed tools), (d) round-trip the structured `{error: "no_session", message}` envelope for a representative subset of tools (one per category) to verify the SDK's content/result framing of error envelopes survives intact, (e) verify Zod input validation rejects malformed inputs (missing required field, zero/negative on positive-int fields). Catches accidental schema drift, missing descriptions, naming regressions, and SDK-side framing regressions on every PR. (Earlier rev of this section described a separate `test/contract/examples.ts` file for happy-path schema validation — the implementation went with the lighter no_session-roundtrip approach instead, which catches the SDK framing path. If happy-path schema validation becomes important later, `examples.ts` is the deferred shape; rev 5 fold dropped the over-promise.)

Estimated **~600–900 LOC** across `test/tools/*.test.ts` (one file per `src/tools/*.ts`). Still no Chrome.

### Layer 3 — Browser end-to-end (Chromium-primary, Chrome-secondary)

Real headless browser against a built sample-app.

**Browser parameterization.** The user's primary dev environment is **Linux ARM64**, where Google doesn't ship official Chrome — Chromium is the practical local target. (Snap-installed Chrome may be present but is documented as flaky in this context; see gotchas.) So Chromium is the **primary** path; Chrome is the secondary path covered in CI on x86_64.

`chrome-launcher` accepts a `chromePath` option. Tests read `process.env.CDP_TEST_BROWSER` (`"chromium"` | `"chrome"`, **default `"chromium"`**) and pass the resolved binary path. Lookup helper (`test/e2e/setup/browser-path.ts`):

| Env value | Linux x86_64 | Linux ARM64 (primary local) | macOS | Windows |
|---|---|---|---|---|
| `chromium` | `which chromium` → `/usr/bin/chromium` | `which chromium` → `/snap/bin/chromium` or `/usr/bin/chromium` (apt) | Homebrew `chromium` or playwright bundled | `where chromium` (rare; fall back to playwright cache) |
| `chrome` | `chrome-launcher` default detection | **not supported** — fail fast with a clear "Chrome unavailable on Linux ARM64; use CDP_TEST_BROWSER=chromium" message | `chrome-launcher` default | same |

`browser-path.ts` also detects snap-confined Chromium and applies the workarounds noted in gotchas (esp. the `--user-data-dir` location restriction). **Resolution order (fail-fast, no fall-through to silent defaults):**

1. `process.env.CDP_TEST_BROWSER_PATH` — explicit override. CI sets this after `npx playwright install`. Wins everything.
2. `which chromium` (Linux) / `where chromium` (Windows) — local-dev path. Catches `/snap/bin/chromium` and `/usr/bin/chromium`. The snap-confinement workarounds kick in here.
3. Playwright's cache — `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome` (Linux), `~/Library/Caches/ms-playwright/...` (macOS), `%LOCALAPPDATA%\ms-playwright\...` (Windows). Used as a fallback when neither override nor system chromium is present (handy after a fresh `npx playwright install`).
4. **Fail with an actionable install instruction** — never fall back to `chrome-launcher`'s default detection silently, because that's how the wrong browser ends up running and tests pass against the wrong protocol version.

The same helper is reused by the eval harness (`evals/harness/runner.ts`) — both layers go through one resolution path so e2e and L4 evals never test against different browser binaries (Cursor open-Q-2 answer).

**Production code change required for `chromePath`.** `LaunchArgs` in `src/session/browser.ts:11` currently has no `chromePath` field, and `launchChrome()` never forwards one to `chrome-launcher`'s `launch()`. Two options:

- *Option A (recommended).* Add `chromePath?: string` to `LaunchArgs` (and the zod schema for the `launch_chrome` tool in `src/tools/session.ts`), forward it into `LaunchOptions` at `browser.ts:31`. This is the smallest change and lets non-test callers override the binary too — useful on Linux ARM64 even outside the test harness.
- *Option B.* Don't change production code; the e2e suite calls `chrome-launcher.launch({chromePath})` itself in `globalSetup`, then drives lynceus via `attach_chrome({port})`. Skips the `launch_chrome` happy-path coverage in L3 (still covered in L2 via the fake), so Option A is preferred.

Cited in *Files to create / modify* below.

**CI matrix — day 1 (Linux ARM64 focus).** The primary supported environment is **Linux ARM64 + Chromium**. CI must validate this combination first.

| Job | Runner | Browser | Install method | Trigger |
|---|---|---|---|---|
| `e2e-linux-arm64` | `ubuntu-24.04-arm` (GitHub-hosted ARM64) | `chromium` | **Playwright-bundled Chromium** via `npx playwright install --with-deps chromium` (devDep only; we never use `playwright`'s test runner). Pins a specific revision per Playwright version so two PRs running a week apart hit the same browser. | every PR |
| `e2e-linux-x64` | `ubuntu-latest` | `chromium` AND `chrome` — matrix | Same Playwright-bundled Chromium; Chrome via `browser-actions/setup-chrome@latest`. | every PR |

Both jobs gate the PR. The x86_64 `chrome` cell catches Chrome-stable-only regressions; both `chromium` cells catch arch-specific surprises.

**Why NOT `apt-get install chromium-browser`.** On Ubuntu 22.04+ runners, the `chromium-browser` apt package is a **snap transitional shim** — `apt install` actually pulls in the snap, which lands the binary under `/snap/bin/chromium` with all the snap-confinement issues already documented under *Critical gotchas → Snap-confined Chromium*. The CI environment then needs the same `~/snap/chromium/current/` user-data-dir workaround that local dev needs, AND the snap binary's first-run delay (a few seconds while snap warms up) introduces flake. Playwright-bundled Chromium is plain unconfined files under `~/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome` — no sandbox, no first-run cost, no apt/snap arbitration. `browser-path.ts`'s resolution order: `process.env.CDP_TEST_BROWSER_PATH` (explicit override, used in CI) → `which chromium` (local dev — includes snap path) → Playwright's bundled cache (CI default) → fail-fast with an install instruction. The CI workflow sets `CDP_TEST_BROWSER_PATH` from the Playwright cache after the install step.

**CI matrix — follow-on (Windows nightly).** A self-hosted nightly Windows runner can be added later (the user has a Windows host available for this — the machine this plan was authored on). When set up, add a `e2e-windows-nightly` job triggered by the nightly cron, browser `chrome` only (Chromium on Windows is unusual). Self-hosted runner config goes in `.github/workflows/eval-nightly.yml` as a separate job; mark `continue-on-error: true` until the **≥20 consecutive green nightlies across diverse PR loads** bar (defined in the CI plan section below) is met, then promote to gating. Calendar-based gates ("two weeks") are explicitly NOT used — a quiet PR week would let an unstable runner clear the bar.

**Runner.** Vitest in a **separate project** via two-entry `vitest.config.ts` (a `node` project for L1+L2, an `e2e` project for `test/e2e/**`). `npm run test:e2e` is distinct from `npm test`. Sequential (`pool: "forks", poolOptions: { forks: { singleFork: true } }`) — two specs must not fight over the same Chrome.

**Determinism.**
- *Sample-app spinup.* New script `npm run sample:build`. The repo is **not** an npm workspace today (no `workspaces` field in root `package.json`) and Vite is only a dep in `examples/sample-app/package.json`, so the script must explicitly install + build there: `npm ci --prefix examples/sample-app && npm run --prefix examples/sample-app build`. CI's reusable composite action does the same, with `examples/sample-app/node_modules` and `examples/sample-app/dist` both cached on `package-lock.json` hash. (Optional follow-up: convert to npm workspaces; out of scope for this plan to keep the diff small.) Built output is served via a tiny static server (`sirv`/`serve-handler`) bound to `port: 0` in vitest `globalSetup`. **Do not use `vite dev`** — HMR re-parses scripts (randomizing `scriptId`s) and `nav.ts:135`'s `networkidle` filter still hangs on `vite`'s long-poll WebSocket if the static-server fallback isn't honored.
- *Chrome port.* Already `--remote-debugging-port=0` (`src/session/browser.ts:34`).
- *Process leaks.* `globalTeardown` SIGKILLs any tracked `chrome.pid` from a tempfile — wraps `chrome.kill()` flakiness on worker crash.
- *Per-session isolation, not per-spec rebuild.* `pool: "forks", singleFork: true` makes specs sequential in one fork. Each spec ends with `close_session`, which calls `sessionState.reset()` (`state.ts:59–74`), which `clear()`s the `ScriptStore`. The only intra-session contamination risk is the HMR upsert leak called out in *Critical gotchas → HMR source-map cache leak*, fixed by the `ScriptStore.clear()` doc-comment hardening in `src/sourcemap/store.ts`. So no per-spec rebuild is required — specs share the static server and one launched browser; isolation comes from `close_session` between specs. (Earlier rev of this plan called for `dist-e2e/<test-id>/` per-spec; that was solving a problem that doesn't exist after the doc-comment fix lands.) **Wire the close as a shared `afterEach` in `test/e2e/setup/global.ts`** (`afterEach(async () => { try { await closeSession(); } catch {} })`) so a thrown assertion mid-spec doesn't leak open-session/breakpoint/paused-execution state to the next spec — relying on per-spec `close_session` discipline is fragile because vitest's `singleFork: true` keeps the same fork running after a thrown assertion. The same pattern as the existing `test/setup.ts` for L2 contract tests.
- *Flake budget.* L3 specs use vitest's `test.retry(1)` by default. Per-spec escalation to `retry: 2` requires an inline comment citing a tracked flake in `docs/known-chromium-gaps.md`. **Do not silently raise to `retry: 3`** — that hides real regressions. ARM64 + snap-Chromium is newer infrastructure; the budget exists to absorb genuine flake without becoming a regression-blindfold.

**Spec inventory (~10).** All under `test/e2e/`:
- `lifecycle.e2e.test.ts` — launch + attach + close round-trip; `list_targets`, `select_target`.
- `breakpoint-flow.e2e.test.ts` — `set_breakpoint(handlers.ts:12)` resolves to a JS coord; click triggers pause; `get_call_stack` shows TS frame; `get_scope` shows `count`; `evaluate("count + step")` returns 2; `resume` clears pause.
- `stepping.e2e.test.ts` — `step_over` from line 12 lands at line 13; `step_into`/`step_out` traverse `computeStep`.
- `exceptions.e2e.test.ts` — `set_pause_on_exceptions: "all"` + `evaluate("throw new Error('x')")` pauses.
- `console.e2e.test.ts` — after click, `get_console_logs` contains expected entry with `mappedFile: "src/main.ts"`.
- `network.e2e.test.ts` — after `navigate`, `get_network_requests` contains the document; `get_response_body` decodes correctly.
- `worker.e2e.test.ts` — sample-app variant spawning a Web Worker; `list_targets` enumerates it; pausing in the worker routes by `session_id`.
- `screenshot.e2e.test.ts` — bytes start with PNG magic; JPEG quality respected.
- `dom.e2e.test.ts` — `query_selector`, `click`, `type_text`, `press_key` happy paths + `not_found`.

These tests **also validate the L2 fakes are faithful** — anything that passes L2 but fails L3 indicates the fake is wrong.

### Layer 4 — Agent evals

> **Post-#47/#48/#49 fold note (2026-05-18).** The L4 harness now runs behind a vendor-agnostic `VendorAdapter` seam. The plan text below is the original implementation specification (Anthropic-only); the *current* multi-vendor architecture lives behind the `VendorAdapter` seam in `evals/harness/vendor.ts`. Where the plan refers to specific SDK fields (`cache_creation_input_tokens`, `Message`), those now live inside `evals/harness/anthropic.ts` and the runner consumes the vendor-agnostic `NormalizedMessage` shape via `evals/harness/vendor.ts`. Trace shape is post-#49: `ScenarioStartEntry.provider: Vendor`, `UsageEntry.cacheTokens?: Record<string, number>`, filenames `<scenario>-<vendor>-<sanitized-model>-trial-<N>.ndjson` — `readTraceFile` folds pre-#49 traces forward.

**Harness — custom Anthropic SDK** (per user choice; pairs with the `claude-api` skill). `~300 LoC` across `evals/harness/{runner,grader,trace}.ts`:
- Spawn `dist/index.js` as an MCP subprocess.
- Drive Anthropic SDK tool-use loop with the lynceus tool list.
- Log every `(tool_name, input, output, error_code?)` tuple → `trace.ndjson` per run.
- `temperature=0`, fixed `max_tokens`, pinned **public** model ID (`claude-opus-4-7` today — drop the `[1m]` 1M-context variant tag for harness portability; bump deliberately). Keep the choice in a single `evals/harness/model.ts` constant so future bumps are a one-line change.
- **Prompt-caching wiring (concrete).** The Anthropic SDK requires explicit `cache_control: { type: "ephemeral" }` on the message blocks intended to be cached — caching is *not* automatic. The harness sets `cache_control` on the *last* block of: (a) the system prompt, and (b) the tool definitions array. Per-trial messages (the user's scenario prompt + the running tool-call/tool-result transcript) are NOT marked cache_control — they're per-trial and shouldn't waste cache budget. With this wiring, the system prompt + tool list (the large, static parts — together ~40K input tokens) hit cache on every trial after the first. The cost-table assumption of ~90% cache hit on input depends on this exact placement; document it inline in `evals/harness/runner.ts` as a comment so future tweaks don't silently cost-regress. Verify post-deploy via the `cache_creation_input_tokens` and `cache_read_input_tokens` fields on the API response.
- Inject `ANTHROPIC_API_KEY` from env (CI secret).

**Scenario library — fork sample-app per scenario** (per user choice). `evals/sample-app-variants/<scenario>/` keeps the canonical `examples/sample-app/` pristine. Each scenario is `{name, variantDir, prompt, oracle}` in `evals/scenarios/<name>.ts`:

1. **`compute-step.ts`** — stock variant. Prompt: "Clicking Go increments by 2, not 1. Find the line." Oracle: trace contains `set_breakpoint(handlers.ts, line∈{11,12})`, then `wait_for_pause`, then inspection of `step` or `computeStep()`; final answer mentions `handlers.ts:12`.
2. **`network-bug.ts`** — variant fetches `/api/wrong-endpoint` (404) on click. Oracle: trace contains `get_network_requests` with `status: 404`; final answer names the wrong URL.
3. **`console-error.ts`** — variant has a `TypeError` in the click handler. Oracle: trace contains `get_console_logs` filtered by `level: "error"`; final answer cites the source-mapped `mappedFile + mappedLine` (validates source-mapped exception traces specifically).
4. **`event-binding.ts`** — variant binds `addEventListener("clik", ...)` (typo). Oracle: `trace.filter(c => c.tool === "wait_for_pause").length <= 2` (proves the agent didn't keep retrying); trace contains at least one `query_selector` or `get_element_html` after the second `wait_for_pause`; final answer mentions either "no listener" or the typo'd event name. Tests graceful timeout handling with a programmatic predicate, not a vibes-based "doesn't keep retrying."
5. **`deep-source-map.ts`** — variant nests bug in `src/lib/utils/math.ts`. Oracle: `set_breakpoint` succeeds via `pathMatches` suffix logic; trace shows correct file binding.
6. **`worker-bug.ts`** — variant computes step in a Web Worker that returns the wrong value. Oracle: trace shows `list_targets`, `pause(session_id=...)`, and `get_object_properties(session_id=...)` with the worker's session id. **Highest-value scenario** — the multi-session compound-key plumbing is the whole reason for the design.
7. **`adversarial-out-of-order.ts`** — stock variant, system prompt deliberately omits the "set_breakpoint then wait_for_pause then click" guidance. Oracle: agent calls something like `get_call_stack` first (gets `not_paused`), recovers, completes within 15 tool calls.
8. **`conditional-bp.ts`** — variant where bug only manifests on the third click. Oracle: trace contains `set_breakpoint` with a `condition: "count >= ..."` rather than spamming `step`.

**Scoring rubric — three programmatic axes (no LLM judge, avoids grader bias):**
- **Correctness (0/1)**: regex/predicate over final-answer + trace.
- **Efficiency**: `tool_calls / oracle_minimum`, capped at 1.0. Diagnostic only — flags wasted exploration.
- **Recovery**: count of distinct error codes in trace where the *next* tool call differs from the failing one. Diagnostic.

Aggregate: pass-rate per scenario across **3 trials**, gate on **median ≥ 2/3**. Report median, not mean.

**Cost gating.** L4 full suite runs **nightly on `main`**. Per-PR runs only `compute-step` × 1 trial unless PR title contains `[full-eval]`. Cost estimate (assumptions explicit so price/model bumps don't require re-deriving).

> **2026-05 cost reality update — empirical is the new source of truth.** The pre-implementation table below assumed Opus 4.7 at list price + the 22K output-tokens-per-trial assumption. The first real-money Sonnet 4.6 nightly came in at **~$5–10/run** vs. the table's $45/night Opus-4.7-equivalent estimate — roughly 5× under. The most likely cause is that the 90% cache-hit assumption + cached-input pricing dominate, plus the 22K output-tokens/trial figure was conservative. With the default swapped to Opus 4.7 medium-thinking (2026-05), the expected nightly is **~$20–30/run** if the same over-estimation pattern holds; the first real run will tighten this. **The numbers below are kept for the per-token derivation, not as a live source of truth — refer to actual run logs under `evals/runs/<run-id>/` and the Anthropic console for the empirical figure.**

| Assumption | Value |
|---|---|
| Scenarios × trials | 8 × 3 = 24 trials |
| Tool calls per trial | ~30 |
| Server-emitted output tokens per tool call | ~500 (≈2KB JSON tool response) |
| Server-emitted output tokens / trial | ~15K |
| **Model-emitted output tokens / trial** (assistant text between tool calls — reasoning, commentary, final answer) | **~7K** (~150–300 tokens × 30 turns) |
| Total output tokens / trial | ~22K |
| Total output tokens, all 24 trials | ~530K |
| Input tokens / trial (cached: system prompt + tool list ≈ 40K; uncached deltas: per-call tool-result transcript ≈ 10K) | ~50K input @ ~90% cache hit |
| Opus 4.7 list price (today) | $15/MTok input, $1.50/MTok cached input, $75/MTok output |
| Output cost | 530K × $75/MTok ≈ **$40** |
| Input cost (10% uncached × 50K × 24 = 120K) | 120K × $15/MTok ≈ **$1.80** |
| Cached input cost (90% × 50K × 24 = 1.08M) | 1.08M × $1.50/MTok ≈ **$1.62** |
| **Pre-implementation estimate (superseded — see note above)** | ~$45/night derived; empirical ~$5–10 (Sonnet); first observed ~$4 (Opus medium, 1 data point — not yet a steady-state band) |
| **Extended thinking** | **Now enabled by default** on adaptive-style models (Opus 4.7+) at medium effort, per the 2026-05 default-model swap. Sonnet 4.6 (budget-style, opt-in) keeps thinking off by default. Override either way via `EVAL_REASONING_LEVEL`. |

If the budget feels too rich during initial calibration, drop to 2 trials per scenario (~$30) or run only 4 scenarios per night on a rotating schedule (~$22). Per-PR `eval-quick` (one scenario, one trial) is in the **~$2** range and is safe to keep on by default.

**L4 parallelism: serial (single process), pinned.** The cache-hit assumption (90%) only holds if trials run *serially* — the Anthropic prompt cache is per-API-key but per-request-prefix, so multiple parallel runners building the same prefix on cold caches each pay full input price the first time. If `evals/harness/runner.ts` parallelizes scenarios across processes, cache hits collapse and the input cost is wrong by 5–10×. **Decision: scenarios run serially. Parallelism is an explicit budget tradeoff, not a default.**

**Model deprecation playbook.** When `claude-opus-4-7` (the harness pin) is deprecated:
1. Promote the deprecated model to a "last-known-baseline" comparison job — keep it running on its existing thresholds, but `continue-on-error: true`.
2. Re-baseline all 8 scenarios against the candidate next-gen model: run each scenario 5× (not 3×) to get a tighter estimate, record per-scenario pass-rate.
3. Update median-gate thresholds in `evals/harness/model.ts` (typically next-gen models tighten gates, but adversarial-out-of-order may regress on more agreeable models — judge per-scenario, not en bloc).
4. Promote the new model to gating; drop the comparison job after 30 days of stability.
This avoids the 4 AM "nightly is 410'ing" page when Anthropic deprecates a model.

---

## CI plan (`.github/workflows/`)

| Layer | Trigger | Job | Runner | Browser |
|---|---|---|---|---|
| typecheck + L1 + L2 + smoke | every PR push | `unit` | ubuntu-24.04-arm, ubuntu-latest, windows-latest | n/a |
| L3 e2e (ARM64, primary) | every PR push, after `unit` | `e2e-linux-arm64` | ubuntu-24.04-arm | `chromium` |
| L3 e2e (x64) | every PR push, after `unit` | `e2e-linux-x64` (matrix) | ubuntu-latest | `chromium` AND `chrome` |
| L4 single-scenario | every PR push, after `e2e` jobs | `eval-quick` | ubuntu-24.04-arm | `chromium` |
| L4 full | nightly cron + `workflow_dispatch` | `eval-full` | ubuntu-24.04-arm | `chromium` |
| L3 e2e (Windows, follow-on) | nightly cron, opt-in via self-hosted runner | `e2e-windows-nightly` | self-hosted Windows | `chrome` |
| Sample-app build | reusable composite action — `vite build`, cache `examples/sample-app/dist/` | invoked by `e2e`, `eval-*` | n/a | n/a |

Day 1: Windows runner mirrors `unit` only (typecheck + L1/L2). The Windows e2e nightly is a deliberate follow-on once a self-hosted runner is provisioned on the user's Windows host. Promotion criterion: **≥20 consecutive green nightlies across diverse PR loads** (not "~2 weeks of calendar time" — calendar-based gates fail when there's a quiet PR week). `continue-on-error: true` until that bar is met, then promote to gating.

`ANTHROPIC_API_KEY` lives in repository secrets; `eval-quick`/`eval-full` jobs are gated on `secrets.ANTHROPIC_API_KEY != ''` so PRs from forks degrade gracefully.

---

## Critical gotchas (must encode in code/comments, not just memory)

- **Pause race.** `waitForPauseOrResume` entry guard at `src/session/pause.ts:75` is the load-bearing fix for batched `Debugger.paused` events. L2 fake's `send` runs `onSend` hooks in the call body, before the Promise it returns is constructed — NOT via `setImmediate` or microtask deferral. Production handlers registered via `client.on(...)` before the awaited `send()` therefore see hook-emitted events inline with the response. (Aligned with the rev-4 wording at the *Fake CRI* section above; earlier rev of this gotcha used "synchronous" without the call-body-vs-microtask distinction.)
- **Auto-attach replay.** `connectToTarget` registers `Target.attachedToTarget` *before* `setAutoAttach` (`browser.ts:106`). Fake must replay pre-seeded `attachedToTarget` events synchronously inside the `setAutoAttach` send-handler.
- **`flatten:true` event shape.** Session events arrive on the root socket with `eventSessionId` as a second emit argument. A one-arg fake silently bypasses the `eventSessionId !== sessionId` guard.
- **`networkidle` HMR trap.** `nav.ts:135` filters WebSocket/EventSource. L3 must use a *static* server, not `vite dev`, or `navigate({wait: "networkidle"})` will hang.
- **Chrome zombies on test crash.** Vitest worker death bypasses `afterEach`. `globalTeardown` SIGKILLs any tracked PIDs.
- **Strict-port collision.** `vite.config.ts` has `strictPort: true` on 5173 — fine for local dev, catastrophic in CI. The L3 static server must bind to `0` and pass the assigned port via env.
- **CDP requestId collisions.** Already worked around by `(requestId, sessionId)` predicates (`browser.ts:249`) — fake must emit colliding `requestId`s in two sessions to keep this regression-tested.
- **HMR source-map cache leak.** `ScriptStore.clear()` only fires on `close_session`/`switchTarget`. After `reload`, scripts upsert (same `scriptId`) but `consumer` survives because `Object.assign(existing, info)` doesn't overwrite unset keys. Add a contract test + a doc comment in `store.ts`.
- **Chromium ≠ Chrome — and the skip mechanism's primary-target trap.** Older Chromium ships an older `devtools-protocol` revision than the pinned `^0.0.1628107`. Some methods (notably `Network.loadNetworkResource`, `Page.captureScreenshot` flags) gained options across versions. **Canonical skip mechanism: a `// @chromium-skip — <gap-id>` comment on the spec's `it()` line.** The runner greps for this tag and combines it with a runtime guard (`it.skipIf(process.env.CDP_TEST_BROWSER === "chromium")`). Pick this single mechanism and use it everywhere — do NOT mix in alternative skip styles (e.g., `it.skip` with prose explanations, `if (...) return;` inside the spec body), or cross-spec consistency rots. **Critical primary-target gotcha:** since Chromium is the primary local target on Linux ARM64, an `@chromium-skip` spec runs ONLY on the x86_64 + chrome cell of the matrix and is **unrun on ARM64 + chromium**. That makes every `@chromium-skip` a real coverage gap on the primary target, not a CI-only triage concession. Each skip MUST land with a row in `docs/known-chromium-gaps.md` documenting the missing protocol method + the target Chromium version that fixes it.
- **Snap-confined Chromium/Chrome on Linux ARM64.** Snap packages run inside a confinement sandbox that restricts filesystem access. Three concrete failures the e2e harness must work around:
  1. `--user-data-dir=/tmp/...` is **rejected** — snap-confined apps can only write under `~/snap/<app>/current/`. The launcher helper must detect a snap path (binary lives under `/snap/`) and route `userDataDir` to `~/snap/chromium/current/lynceus-test-profile/`.
  2. `--remote-debugging-port` is honored, but the port socket lives inside the snap's namespace; `CDP.List` from the host process still works because snap maps `127.0.0.1` through, but bind failures surface as opaque "ECONNREFUSED" instead of "EADDRINUSE". Add a probe in `globalSetup` that retries port detection for ~2s before failing.
  3. The "supposedly" qualifier from the user means **don't assume snap-Chrome is present**; the resolution helper must `which`-check and emit a single actionable error if neither `/snap/bin/chromium` nor `/usr/bin/chromium` exists ("install via `sudo snap install chromium` or `sudo apt-get install chromium-browser`").
- **LLM eval flakiness.** `temperature=0` is necessary but not sufficient. Three-trial median gate. Pin model string. Treat eval failures as signal for a model bump conversation, not a test bug.

---

## Files to create / modify

**New:**
- `vitest.config.ts` — two-project setup (`node`, `e2e`).
- `test/fake-cdp.ts` — CRI fake builder + EventEmitter scaffolding. **Linchpin file**; quality of L2 hinges on this.
- `test/tools/{session,nav,source,breakpoints,execution,inspect,console,network,dom}.test.ts` — L2 contract tests, one per `src/tools/*.ts`.
- `test/contract/tool-registration.test.ts` — schema + description sanity loop.
- `test/e2e/setup/{static-server.ts,browser-path.ts,global.ts}` — sample-app server, Chrome/Chromium resolution, vitest `globalSetup`/`globalTeardown`.
- `test/e2e/{lifecycle,breakpoint-flow,stepping,exceptions,console,network,worker,screenshot,dom}.e2e.test.ts`.
- `evals/harness/{runner,grader,trace}.ts` — Anthropic SDK harness.
- `evals/scenarios/{compute-step,network-bug,console-error,event-binding,deep-source-map,worker-bug,adversarial-out-of-order,conditional-bp}.ts`.
- `evals/sample-app-variants/<scenario>/` — forked sample-apps.
- `.github/workflows/{ci.yml,eval-nightly.yml}`.
- `src/util/format.test.ts`.
- `docs/known-chromium-gaps.md` — running list of `@chromium-skip` specs with the missing CDP method and target Chromium version that fixes it. Enforced by `scripts/check-chromium-skips.mjs` (see below).
- `scripts/check-chromium-skips.mjs` — enforcement script for the chromium-skip policy. Greps `test/e2e/**/*.test.ts` for `@chromium-skip` tags + `it.skipIf`/`describe.skipIf` Chromium guards, parses `docs/known-chromium-gaps.md`'s table, fails (exit 1) if any skip lacks a tracking row OR any tracking row references a spec that no longer exists. Wired into `pretest:e2e` so it gates every PR run, AND exposed as `npm run lint:chromium-skips` for ad-hoc runs.

**Modify:**
- `package.json` — scripts: `test:e2e`, `eval`, `eval:quick`, `sample:build` (last includes `npm ci --prefix examples/sample-app`). **`preeval` and `preeval:quick`** (npm's actual `pre<scriptname>` lifecycle hook — not the `prebuild:eval` / `pretest:eval` form rev 2 used, which are not real npm pre-hooks for `eval`) so `npm run eval`/`npm run eval:quick` rebuilds `dist/` automatically (prevents the "I forgot to rebuild after editing src" footgun and ensures CI L4 jobs always have a fresh subprocess target). Also wire `pretest:e2e` for `test:e2e` if `dist/` is needed by the e2e harness. devDeps: `@anthropic-ai/sdk`, `sirv` (or `serve-handler`), `@modelcontextprotocol/sdk`'s client + InMemoryTransport already ship in the existing dep.
- New script `scripts/check-chromium-skips.mjs` — wired into both `test:e2e` (`pretest:e2e` chain) and a standalone `npm run lint:chromium-skips`. Greps `test/e2e/**/*.test.ts` for `@chromium-skip` tags + `it.skipIf`/`describe.skipIf` Chromium guards, reads `docs/known-chromium-gaps.md`'s table, asserts every skip has a row and every row references a real spec. Exit code 1 on mismatch — that's the enforcement that backs the policy in `docs/known-chromium-gaps.md`. Without this, the policy is convention-only and silently rots.
- `src/session/browser.ts` — add optional `chromePath?: string` to `LaunchArgs` (line 11) and forward into `LaunchOptions` at line 31.
- `src/tools/session.ts` — extend `launch_chrome` zod schema with `chrome_path?` so the new field is reachable from MCP callers.
- `src/tools/breakpoints.ts` — export `buildConditionExpression` with a `@internal` JSDoc tag (signals "test-only export, not API surface" — TS doesn't enforce, readers and api-extractor honor).
- `src/tools/execution.ts` — export `matchUserBreakpoints` with the same `@internal` JSDoc tag.
- `src/server.ts` — *only if InMemoryTransport approach (preferred) proves insufficient*: add `getRegisteredHandlers()` debug helper. Skip otherwise.
- `src/sourcemap/store.ts` — doc comment on the HMR upsert behavior (the `Object.assign(existing, info)` non-overwrite of `consumer`).
- `README.md` — short "Testing" section pointing at `npm test`, `npm run test:e2e`, `npm run eval`, the `CDP_TEST_BROWSER` env (default `chromium`, fallback `chrome`), the snap-Chromium caveat for Linux ARM64, and the `[full-eval]` PR-title flag.

**Pre-seed:**
- `docs/known-chromium-gaps.md` — populate at creation time with the two known-risky CDP methods the plan itself flags (`Network.loadNetworkResource`, `Page.captureScreenshot` flag set), plus a "no entries below this line means no skips were needed" footer so the file isn't ambiguously empty for the next contributor.

**Critical paths to keep open while implementing:**
- `src/session/state.ts` (the seam — `client` field at line 31)
- `src/session/browser.ts` (event/session contract the fake must match — esp. lines 101–130)
- `src/tools/_register.ts` (uniform error envelope at lines 21–35)
- `src/sourcemap/store.ts` (multi-session compound-key invariants)

---

## Verification

### Per-PR (recurring, every contributor checks)

1. **`npm test`** — green; `vitest --coverage` shows L1+L2 coverage on `src/tools/*.ts` jumps from 0% to >85% statement coverage.
2. **`npm run smoke`** — still green (unchanged contract).
3. **`npm run test:e2e`** — green locally with the default `CDP_TEST_BROWSER=chromium` (the primary target on Linux ARM64). On x86_64 hosts, also green with `CDP_TEST_BROWSER=chrome`. Any spec needing `@chromium-skip` is documented in `docs/known-chromium-gaps.md`. On Linux ARM64 with snap-Chromium, the `~/snap/chromium/current/` profile workaround is exercised on first run (no permission errors).
4. **`npm run eval -- --scenarios=compute-step`** — single-scenario run completes, prints trace + 1/0 score; scoreboard shows `compute-step: pass (3/3)` over three trials.

### Post-implementation (one-time gate, only when test infra first lands)

5. **`npm run eval`** — full 8-scenario × 3-trial run completes within budget; aggregate report shows ≥6/8 scenarios passing median.
6. **CI dry-run** — open a draft PR with a no-op change; `unit`, `e2e-linux-arm64`, `e2e-linux-x64` (chromium + chrome), `eval-quick` all complete green within ~10 min total. Manually trigger `eval-full` via `workflow_dispatch` to confirm the full path runs end-to-end.
7. **Regression-fail check** — temporarily revert one of the multi-session compound-key fixes (the worker-collision regression noted in `store.test.ts`); confirm `worker-bug.ts` eval AND `worker.e2e.test.ts` AND L2 session-routing tests **all** fail. Restore the fix. *Do this once when the suite first lands; not on every PR.*
8. **Cost-baseline check** — after the first nightly eval run, inspect the Anthropic dashboard; confirm cached-input rate is high (system prompt + tool list should hit the cache on every trial after the first), and that nightly cost lands within the empirical band (~$5–10 on Sonnet 4.6 baseline; first observed ~$4 on Opus-4.7-medium default — one data point, not yet a steady-state band; see *L4 → Cost gating* note above for why the pre-impl ~$45 estimate is superseded). If significantly higher than the observation, the most likely causes in priority order: (a) parallel scenario execution collapsed cache hits, (b) cache_control placement wrong on the harness's API requests, (c) thinking-effort tier silently bumped above medium.

---

## Revision log

- **2026-05-14, rev 1.** Folded Codex (GPT-5.5) findings from `docs/gpt_55_test_plan_review.md`:
  - Added explicit *Production code change required for `chromePath`* sub-section under L3 (Codex Medium #1) and the corresponding `src/session/browser.ts` + `src/tools/session.ts` modifications under *Files to modify*.
  - Reframed the L2 contract test to use the new `getRegisteredHandlers(server)` debug helper rather than the non-existent `buildServer().listTools()` (Codex Medium #2 — `McpServer` only has the private `_registeredTools` field).
  - Spelled out the `npm ci --prefix examples/sample-app` install step in `sample:build` and the CI composite action; noted the optional follow-up of converting to npm workspaces (Codex Low #4).
  - Switched the pinned eval model ID from the internal `claude-opus-4-7[1m]` (1M-context variant tag) to the public `claude-opus-4-7` for harness portability, hoisted to a single `evals/harness/model.ts` constant (Codex Low #3 — Codex flagged this as "corrupted"; it's actually a real internal ID, but the public form is the right choice for a portable harness anyway).

- **2026-05-14, rev 2.** Folded Opus 4.7 findings from `docs/reviews_opus_47.md`:
  - **(M-1, fake-CDP spec depth)** Expanded `test/fake-cdp.ts` public surface from 4 bullets to 8 — added `onSend` synchronous side-effect hook (the auto-attach replay mechanism), `seedScript` / `fireNetworkLifecycle` / `makePauseState` macros, and explicit typing-against-`CDP.Client` for fidelity-gap detection. Without these, every per-tool test re-derives the same event shapes and tests diverge.
  - **(M-2, InMemoryTransport)** Promoted `@modelcontextprotocol/sdk/inMemory.js` (verified present in `node_modules/`) as the **recommended** L2 contract-test path. Demoted `getRegisteredHandlers()` to fallback. Less invasive (no production export), more SDK-version-resilient, exercises the full registration→schema→handler→error-envelope chain.
  - **(M-3, cost estimate)** Replaced "low single-digit USD/night" with an explicit assumptions table; realistic estimate is **~$30–35/night** (low double-digit). Added drop-down options (2 trials/scenario or 4 scenarios/night rotation) for budget calibration.
  - **(M-4, flake budget)** Set L3 retry budget: `test.retry(1)` default, escalation to `retry(2)` requires an inline tracked-flake citation. Replaced "two weeks" Windows-promotion criterion with the quantitative ≥20-consecutive-green-nightlies bar.
  - **(L-1, model deprecation playbook)** Added 4-step playbook under *L4 → Cost gating* covering baseline-comparison promotion + 5×re-baseline + per-scenario gate update + 30-day grace.
  - **(L-2, prebuild for L4)** Added `prebuild:eval` / `pretest:eval` to package.json scripts list.
  - **(L-3, internal exports)** Tagged `buildConditionExpression` and `matchUserBreakpoints` exports with `@internal` JSDoc to signal "test-only, not API surface."
  - **(L-4, drop per-spec rebuild)** Replaced per-spec `dist-e2e/<test-id>/` rebuild with attach-only isolation (close_session + ScriptStore.clear()). Saves N rebuild steps per CI run.
  - **(L-5, event-binding oracle)** Replaced "doesn't keep retrying" with `trace.filter(c => c.tool === "wait_for_pause").length <= 2` — a programmatic predicate.
  - **(N-1, regression-check framing)** Split *Verification* into "Per-PR (recurring)" and "Post-implementation (one-time gate)" so the regression-fail exercise isn't framed as something every contributor reruns.
  - **(N-2, seed known-chromium-gaps.md)** Pre-populate at creation time with the two flagged-as-risky CDP methods and a "no entries below this line" footer.

- **2026-05-15, rev 3.** Folded second Codex pass (`local_dont_track/reviews/review_test_eval_plan_docs_by_codex.md`) and Cursor pass (`docs/cursor_test_plan_review.md`):
  - **(Codex M-1, Windows-criterion contradiction)** Removed the residual "~2 weeks of nightlies" line at the L3 follow-on description and unified on the **≥20 consecutive green nightlies across diverse PR loads** bar already in the CI plan section. Calendar-based gates explicitly called out as not used.
  - **(Codex M-2, chromium-skip enforcement is convention-only)** Added `scripts/check-chromium-skips.mjs` to *Files to create* — greps test files for skip tags, parses `docs/known-chromium-gaps.md`'s table, fails if any skip lacks a tracking row or any row points at a missing spec. Wired into `pretest:e2e` and exposed as `npm run lint:chromium-skips`. Without this the policy in known-chromium-gaps.md was promise-only.
  - **(Codex L-1, 8 vs 9 categories)** Updated Context paragraph from "36 tools across 8 categories" to "36 tools across **9 module groups**" with the explicit list (`session`, `nav`, `source`, `breakpoints`, `execution`, `inspect`, `console`, `network`, `dom`) so the count matches `src/server.ts`'s 9 register-call sites and the L2 file list.
  - **(Cursor M-1, npm pre-hook naming bug)** Replaced incorrect `prebuild:eval` / `pretest:eval` with the actual npm lifecycle hook names: **`preeval`** for `npm run eval` and **`preeval:quick`** for `npm run eval:quick`. The previous names would not have triggered any rebuild — silent footgun. Also added `pretest:e2e` for the new chromium-skip-policy script.
  - **(Cursor M-2, Chromium install strategy)** Replaced `apt-get install chromium-browser` with **Playwright-bundled Chromium** (`npx playwright install --with-deps chromium`, devDep only — we never use playwright's test runner). Added explicit *Why NOT apt* sub-paragraph documenting the Ubuntu 22.04+ snap-transitional-shim issue (apt's `chromium-browser` actually pulls in the snap). Defined the `browser-path.ts` resolution order explicitly with a fail-fast policy on the fallback (Cursor open-Q-2 answer: e2e and eval reuse one helper).
  - **(Cursor L-1, prompt-caching specifics)** Added concrete `cache_control: { type: "ephemeral" }` placement guidance (last block of system prompt + last entry of tools array; per-trial messages NOT cached). Cited the `cache_creation_input_tokens` / `cache_read_input_tokens` API response fields for post-deploy verification. Cost-table assumption now traceable to a concrete implementation pattern.
  - **(Cursor open-Q-1, always-rebuild vs ci-only)** Resolved in favor of always-rebuild via `preeval` — simplest, prevents stale-dist surprises both locally and in CI. The cost is one extra `tsc` per `npm run eval` call; acceptable.
  - **(Cursor open-Q-2, unified browser-binary helper)** Resolved: `test/e2e/setup/browser-path.ts` is also imported by `evals/harness/runner.ts` so both layers go through one resolution path. Documented inline.

- **2026-05-15, rev 4.** Folded 6 Opus 4.7 findings from the post-rev-2 review (`agentic-programming-process/skills/multi-reviewer-plan-iteration/evidence/reviews/lynceus/05_opus_rev2_impl.md`). N-2 (`prebuild:eval` not a real npm hook) was already addressed by Cursor in rev 3.
  - **(Opus N-1, Med — cost table missing assistant tokens)** Cost table only counted server-emitted tool responses (~15K output tokens/trial), not the model's own emitted assistant text + reasoning between tool calls (~7K/trial). Recalculated to ~22K total/trial → 530K total → ~$40 output + ~$3.50 input ≈ **~$45/night** (was claimed as $30–35). Added explicit **Extended thinking: Disabled** decision row (would push to ~$85 if enabled). Updated *Verification → Cost-baseline check* to ~$45/night and listed the three most likely overage causes in priority order (thinking accidentally enabled, parallel execution, wrong cache_control placement).
  - **(Opus N-3, Low — chromium-skip semantics + primary-target trap)** Picked `// @chromium-skip — <gap-id>` comment + `it.skipIf(env === "chromium")` runtime guard as the **single canonical mechanism** (was previously listed as alternatives, leading to inconsistent skip styles). Added explicit primary-target trap warning: a `@chromium-skip` spec runs ONLY on the x86_64 + chrome cell and is unrun on ARM64 + chromium (the primary target). Every skip is therefore a real coverage gap on the primary target, not just CI triage. Each skip MUST land with a tracking row in `docs/known-chromium-gaps.md` documenting the missing protocol method and target Chromium version.
  - **(Opus N-4, Low — `seedScript` phantom second event)** Original wording said "fires `Debugger.scriptParsed` (and optionally a `Debugger.scriptParsed` for the source-map URL)". CDP fires ONE event per script with `sourceMapURL` as a *field* on the event payload, not a second event. Reworded to single-event with `sourceMapURL` as a field. The implementation was already correct; only the plan text was misleading.
  - **(Opus N-5, Low — `onSend` synchronicity wording imprecise)** Original said "fires synchronously in the same microtask the `send()` resolves" — conflated two distinct timings (Promise resolution always defers to microtask; what tests need is the hook running BEFORE the awaited send returns control). Reworded to "the hook runs in the `send()` call body, before the Promise it returns is constructed — NOT via setImmediate or microtask deferral." Implementation was already correct; only wording was loose.
  - **(Opus N-6, Low — close_session needs afterEach hook, not per-spec discipline)** L3 isolation was specified as "specs share the static server and one launched browser; isolation comes from `close_session` between specs" — works only if every spec explicitly calls close AND doesn't crash before reaching it. Vitest's `singleFork: true` keeps the same fork running after a thrown assertion, leaking state to the next spec. Added: **wire close as a shared `afterEach` in `test/e2e/setup/global.ts`** (`afterEach(async () => { try { await closeSession(); } catch {} })`). Same pattern as `test/setup.ts` for L2 contract tests.
  - **(Opus N-7, Nit — L4 parallelism not pinned)** Cost-table 90% cache-hit assumption only holds if trials run serially (Anthropic prompt cache is per-API-key but per-request-prefix; parallel runners on cold caches each pay full input price the first time). Made **serial execution explicit and pinned**: scenarios run serially (single process); parallelism is an explicit budget tradeoff, not a default. If parallelized, input cost is wrong by 5–10×.

- **2026-05-15, rev 5.** Folded round-2 review on PR #10: 1 Codex Med + 2 Opus Med + 3 Opus Low + 3 Opus Nit + 1 Cursor Low. Plus +2 self-tests of the fail-fast change.
  - **(Codex Med, fake-cdp `{}` fallback for unknown methods)** Replaced silent `{}` return with **fail-fast** + an explicit `KNOWN_VOID_METHODS` allowlist in `test/fake-cdp.ts`. Production code that adds a new CDP call now fails the test loudly with a message naming the method, instead of silently passing. The allowlist contains only methods production legitimately fires-and-forgets (`Runtime.enable`, `Page.enable`, `Debugger.resume`, etc.). Added 2 self-tests: one asserting the throw, one asserting allowlisted methods still no-op.
  - **(Opus Med-1, plan/impl drift on handler-access mechanism)** Plan said "InMemoryTransport (recommended), getRegisteredHandlers (fallback)" but the implementation chose neither for per-tool L2 — `test/handler-registry.ts`'s `captureTools()` is the actual mechanism. Updated the *Handler access* section to record `captureTools` as the chosen approach (with rationale: doesn't couple production to a test concern, doesn't reach into `_registeredTools`). InMemoryTransport scoped to the single contract test only; `getRegisteredHandlers()` documented as the still-available escape hatch.
  - **(Opus Med-2, plan describes nonexistent `test/contract/examples.ts`)** Plan over-promised a happy-path schema-validation file that the implementation didn't land (the contract test does no_session-roundtrips for SDK-framing validation instead). Updated the *Bonus contract test* description to record what was actually built (no_session round-trip for representative subset, bidirectional name-set check, schema well-formedness, Zod-rejection check). `examples.ts` deferred as a future expansion if happy-path schema validation becomes important.
  - **(Opus Low-1, handler-registry magic-string sentinel list redundant)** Removed the explicit list of plain-text return values (`"ok" | "removed" | "cleared" | ...`) from `parseOkEnvelope`'s special-case handling. The catch block in the subsequent `try { JSON.parse }` already returns text-as-T for unparseable text, making the list structurally redundant. Future tools adding new sentinel returns will work without extending a hardcoded list.
  - **(Opus Low-2, contract test name-list one-directional)** `expected.forEach(name => names.has(name))` only checked names were PRESENT, not that there were no EXTRAS. Combined with the "exactly 36 tools" count check it caught additions but not renames-with-stale-list. Tightened to `expect(names).toEqual(new Set(expected))` for both directions in one assertion.
  - **(Opus Low-3, plan line 209 Pause race wording lagged rev-4 fix)** The *Critical gotchas → Pause race* entry still used the older "synchronous event-fire hook (not setImmediate)" wording. Aligned with the rev-4 wording at the *Fake CRI* section ("hook runs in the send() call body, before the Promise it returns is constructed — NOT via setImmediate or microtask deferral").
  - **(Cursor Low, `makeFakeCdp.close()` incomplete reset)** `close()` previously only removed listeners despite the doc claiming safe reuse; left `hooks` and `sentCalls` intact. Reworded close() to also `hooks.clear()` and `sentCalls.length = 0`. Responders deliberately NOT cleared (they're meant to be sticky for tests sharing a fake across multiple acts; tests wanting a fresh fake should construct a new one). Updated the doc-comment to reflect this scope.
  - **(Opus Nit-1, `session.test.ts` style asymmetry not explained)** Added a file-top IMPLEMENTATION NOTE explaining why this file uses `vi.mock` instead of the unified `sessionState.client = fake` seam pattern (chrome-launcher and chrome-remote-interface are static imports; only vitest module mocking can intercept them). Future maintainers won't try to "unify the style."
  - **(Opus Nit-2, misleading test name)** Renamed `clear_console (no args required): succeeds with empty arguments` to `... handler dispatches without arg-validation rejection — surfaces no_session error envelope, not a transport-level reject` (which is what the body actually asserts).
  - **(Opus Nit-3, `makePauseState` collision risk on multi-pause tests)** Added a `pauseStateSeed` counter so back-to-back `makePauseState()` calls produce non-colliding `objectId` / `callFrameId` values (`scope-local-${seed}`, `frame-${seed}-0`, etc.). Self-test added asserting the non-collision; updated the existing `inspect.test.ts` assertion that hardcoded `"frame-0"` to use a regex match.
  - **Out-of-scope flags from Opus's review** (allowed-owner update + L3 `afterEach(closeSession)` not lost) acknowledged in PR description; both already tracked. No fold needed.
  - **Round-2 reviewer attribution observation:** all three reviewers correctly self-identified this round (Codex now appends model+computer per user enforcement; Opus footer accurate; Cursor was the formal review with no footer but no false claim either). First round in this PR's history where reviewer-identity verification worked cleanly via footer enforcement, vs. the rev-2 / rev-3 hallucinations the meta-cycle in the SKILL repo's evidence file documented. Worth surfacing to the SKILL's *Common failure modes → Trusting reviewer identity self-reports* as positive evidence that footer enforcement, when actually enforced, does work — queued as part of the SKILL rev 5 follow-up.

- **2026-05-15, rev 6.** Removed three review-source files from `docs/` (`gpt_55_test_plan_review.md`, `reviews_opus_47.md`, `cursor_test_plan_review.md`) — they're cited above in the rev-1 / rev-2 / rev-3 fold entries as historical narrative, but the canonical preserved copies now live in the `agentic-programming-process` skill repo at `skills/multi-reviewer-plan-iteration/evidence/reviews/lynceus/{01_codex_rev0,02_opus_rev1,04_cursor_rev2}.md` (committed there since the SKILL PR #1 merge). Reduces lynceus's `docs/` to just the actively-maintained operational docs (`test-eval-plan.md`, `known-chromium-gaps.md`, `design-notes.md`) without losing the review provenance. The Codex r3 + Opus r4 reviews never lived in lynceus's `docs/` — they were always in `local_dont_track/` and now in the skill repo's evidence directory.
