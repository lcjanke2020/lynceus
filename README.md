# cdp-mcp

A Model Context Protocol (MCP) server that exposes the Chrome DevTools Protocol (CDP) to AI agents as a **TypeScript-aware frontend debugger**.

Designed for agents running in CLIs (Claude Code, GitHub Copilot CLI) that have local source + source-map access. Coordinates flow in TS terms; the server translates to JS for CDP under the hood.

**Status:** alpha. **License:** [MIT](./LICENSE).

## What it gives an agent

Across 48 tools:

- **Breakpoints in TS source** — `set_breakpoint(file="src/foo.ts", line=42, condition?, log_message?)`. The server matches source maps and binds in every script that maps back to that file.
- **Stepping** — `step_over`, `step_into`, `step_out`, `resume`, `pause`, plus the authoritative sync point `wait_for_pause`.
- **Live inspection at a paused frame** — `get_call_stack`, `get_scope`, `evaluate` (frame-aware), `get_object_properties`. All call-stack frames are TS-mapped.
- **Buffered console + network** — pull-based, paginated by monotonic `seq`. Bodies are lazy-loaded via `get_request_body` / `get_response_body`.
- **Light DOM interaction** — `query_selector`, `click`, `type_text`, `press_key`, `screenshot` so the agent can drive a flow to a breakpoint.
- **Structured DOM querying** — Playwright-inspired `locate` (LocatorSpec: CSS, text, role, test-id, label, placeholder, name), `wait_for` (poll until DOM state), `get_form_state` (read named form fields).
- **Source-map diagnostics** — `list_scripts`, `resolve_source_position`, `get_script_source`.

Auto-attaches to iframes and workers via `Target.setAutoAttach({ flatten: true })`.

## Install / build

### Runtime install from npm

Requires Node.js 20+ and a local Chrome/Chromium browser.

```sh
npm install -g cdp-mcp
cdp-mcp                           # stdio MCP transport
cdp-mcp --port 9719               # SSE MCP transport on 127.0.0.1:9719
cdp-mcp --host 0.0.0.0 --port 9719 --allow-remote
```

The npm package ships prebuilt `dist/`, so there is no build step for runtime
use. If `launch_chrome` cannot find Chrome/Chromium automatically, set
`CHROME_PATH` to the browser binary.

For MCP clients that support SSE, you can run `cdp-mcp` as a persistent local
service:

- [macOS launchd user service](docs/launchd-service.md)
- [Linux systemd user service](docs/systemd-service.md)

Persistent service mode keeps the `cdp-mcp` process and current browser/CDP
session alive across MCP client restarts or reconnects. It does **not** persist
state across service-process restarts. SSE mode is single-client today; if a
new client should start fresh, call `close_session` first.

### Build from source

```sh
npm install
npm run build
node dist/index.js                    # stdio MCP transport (default — this is what Claude Code launches)
node dist/index.js --port 9719        # SSE MCP transport on 127.0.0.1:9719
node dist/index.js --host 0.0.0.0 --port 9719 --allow-remote
```

SSE mode caveats:

- **Single-client only.** Every `/sse` connection gets its own `McpServer`,
  but every tool funnels through one process-global `sessionState` — two
  concurrent clients race on the same browser (shared pause state,
  breakpoints, console/network buffers; `launch_chrome` from client B
  tears down client A's session).
- **Non-loopback bind requires opt-in.** `--allow-remote` (or
  `CDP_MCP_ALLOW_REMOTE=1`) is required to bind to anything other than
  loopback. MCP tools include `evaluate` (in-page code exec), a
  `screenshot path=` filesystem write, `export_storage_state` (writes full
  cookie values — including HttpOnly auth secrets — to a server-side file) and
  `load_storage_state` (reads an arbitrary server-side file); the gate makes
  remote exposure a deliberate operator decision rather than a default.
- **Host / Origin headers are validated on loopback binds** to block
  DNS-rebinding against `127.0.0.1` / `localhost` / `[::1]`. On
  non-loopback binds the operator has already accepted exposure via
  `--allow-remote`, and the server can't statically enumerate every
  hostname/IP a LAN/VPN/DNS client might reach it by — those checks
  are skipped. If you need per-`Host` policy on a LAN/WAN deployment,
  front the server with a reverse proxy that enforces it.

Smoke test (no browser needed — verifies the protocol surface):

```sh
npm run smoke
```

Unit + L2 contract tests (~640ms, no browser, no LLM):

```sh
npm test
```

The `test/` tree is the L2 contract layer (every tool exercised against a fake
CDP — see `test/fake-cdp.ts`); the inline `src/**/*.test.ts` files are L1
pure-data tests; `evals/**/*.test.ts` cover the L4 harness's
grader/trace/oracle units. See `docs/test-eval-plan.md` for the full pyramid.

### L3 — real-browser end-to-end

```sh
npm run test:e2e
```

Drives the 48 MCP tools against a real headless Chromium attached to a
built copy of `examples/sample-app/`. Eleven specs cover lifecycle, breakpoints,
stepping, exceptions, console, network, workers, screenshot, DOM
interaction, form driving, and storage portability. Sequential (one Chrome shared across specs, isolated by a
shared `afterEach(close_session)`). Run time is a few seconds on a warm
machine.

**Browser selection (`CDP_TEST_BROWSER` env, default `chromium`)**:

| Linux x86_64 | Linux ARM64 (primary local) | macOS | Windows |
|---|---|---|---|
| `chromium`: Playwright's bundled binary, system chromium, or apt | `chromium`: Playwright's bundled binary or apt (`/snap/bin/chromium` honored with snap-confinement userDataDir workaround) | `chromium`: Homebrew / Playwright bundled | `chromium`: Playwright bundled (set `CDP_TEST_BROWSER_PATH`) |
| `chrome`: chrome-launcher auto-detect | **not supported** — fail-fast | `chrome`: chrome-launcher auto-detect | `chrome`: chrome-launcher auto-detect |

**Local-Windows status**: at the time L3 landed, `chrome-launcher` 1.2.1 fails
to bind to its own picked port on Windows 11 (ECONNREFUSED inside chrome-
launcher's startup poll) regardless of headless mode, Chrome stable vs
Playwright Chromium, or explicit ports. The same code path works on Linux
where CI runs. If you need to test L3 changes locally on Windows, run them
under WSL2 (Ubuntu) or push and let CI validate. The unit + L2 tests work
fine on Windows.

Setting an explicit binary path (for example, after running
`npx playwright install chromium` locally on Linux) lets the resolver skip
detection and use the bundled binary:

```sh
export CDP_TEST_BROWSER_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux/chrome"
npm run test:e2e
```

Any spec failing on Chromium-only but passing on Chrome stable should land
with a `// @chromium-skip — <gap-id>` comment AND a row in
`docs/known-chromium-gaps.md` — `npm run lint:chromium-skips` (and the
pretest hook) enforces this.

`launch_chrome` defaults to `--no-sandbox` for Ubuntu/Playwright-Chromium
compatibility. See [`docs/chromium-sandboxing.md`](docs/chromium-sandboxing.md)
before changing that default or relying on `sandbox: true`, AppArmor, snap
confinement, or Bubblewrap. For the step-by-step setup that gets local
`npm run test:e2e` passing with the sandbox **on** (install Playwright Chromium
+ attach the AppArmor profile), see
[`docs/local-l3-e2e-setup.md`](docs/local-l3-e2e-setup.md).

### L4 — LLM agent evals

```sh
export ANTHROPIC_API_KEY=...
npm run eval:quick                 # 1 scenario × 1 trial (~$0.50–2 at default Opus-4.8-medium; ~$0.05 with EVAL_MODEL_OVERRIDE=claude-sonnet-4-6)
npm run eval                       # all scenarios × 3 trials (~$4 full pass — first observed on Opus-4.7-medium, the prior default; 4.8 shares its rate card)
npm run eval -- --scenarios=compute-step --trials=1
```

Use `npm run eval` (or `npm run eval:quick`) — NOT `npx tsx evals/cli.ts` directly. The npm script triggers the `preeval` lifecycle hook which rebuilds `dist/index.js` (the MCP subprocess); calling tsx directly bypasses the hook and a fresh clone fails with `Cannot find module '.../dist/index.js'`. If you must invoke tsx directly, run `npm run build` first.

Drives the cdp-mcp tool surface through an LLM agent via the
`VendorAdapter` seam (`evals/harness/vendor.ts`); the Anthropic adapter
backed by `@anthropic-ai/sdk` is the default and only production path
today. Each trial spawns a fresh `dist/index.js` MCP subprocess + a
static server for the scenario's sample-app variant; the tool-use loop
drives the page, sets source-level breakpoints, inspects pauses, and
produces a natural-language final answer. NDJSON traces land under
`evals/runs/<run-id>/` (gitignored). A programmatic oracle per scenario
(no LLM judge) emits a dual-axis verdict — **mechanic** (did the agent
exercise the debugger workflow under test) + **correctness** (did the
final answer name the bug) — plus efficiency ratio and recovery count.

**Default model**: `claude-opus-4-8` with adaptive thinking at
`effort=medium` (set in `evals/harness/model.ts`). Adaptive-style models
(Opus 4.7+) default to medium-effort thinking when no env override is
set; budget-style models (Sonnet 4.6, selectable via
`EVAL_MODEL_OVERRIDE`) keep extended thinking **off** by default for the
cheap-baseline path. Override via env:

- `EVAL_MODEL_OVERRIDE=claude-sonnet-4-6` — switch to the budget-style
  Sonnet baseline (no thinking by default; ~$5–10/full run).
- `EVAL_REASONING_LEVEL=none|low|medium|high|xhigh|max` — pick a tier
  (or explicit `none` to disable on adaptive models). On budget-style
  models each tier maps to a default `budget_tokens` in
  `TIER_BUDGET_TOKENS` (high=16K). On adaptive models the tier maps
  directly to Anthropic's `effort` parameter.
- `EVAL_REASONING_BUDGET=N` — override the budget on budget-style
  models. Used alone the level is tagged `custom`; used alongside
  `EVAL_REASONING_LEVEL` it overrides that tier's default.

Thinking-on runs are non-deterministic (Anthropic requires
`temperature=1` with `thinking`), so use `--trials >= 3` to characterize
variance. Cost-cap: `$100` per `npm run eval` invocation (override via
`EVAL_BUDGET_USD` env). Rotation across the Anthropic family + GPT-5.5
is a follow-up — see the proposal at
[`docs/eval-model-rotation-proposal.md`](docs/eval-model-rotation-proposal.md).

Caching: the system prompt + tool list are tagged `cache_control:
ephemeral`. The system block (~280 tokens) is below Anthropic's
~1024-token cache-breakpoint minimum, so only the ~5K-token tools array
actually caches across trials — that's enough to dominate the input
cost across trial 2+. Verify post-run via the `cacheTokens` field on
each `t:"usage"` trace entry (the Anthropic adapter populates
`cacheTokens.cacheReadInputTokens` and `cacheTokens.cacheCreationInputTokens`
verbatim from the SDK's `cache_read_input_tokens` / `cache_creation_input_tokens`).

Non-Anthropic backends: the OpenAI vendor adapter ships with #50/#58
(target: GPT-5.5) — `EVAL_PROVIDER=openai` plus `OPENAI_API_KEY`
+ `EVAL_OPENAI_MODEL` activates it. Reasoning-off trials route to
`/v1/chat/completions` (#50); reasoning-on trials route to
`/v1/responses` (#58), the only OpenAI surface that supports tools
× reasoning_effort on GPT-5.5. An LM Studio investigation artifact
is wired behind the same seam for issue #45. See
[evals/README.md](evals/README.md) for full `EVAL_PROVIDER` /
`EVAL_OPENAI_*` / `EVAL_LM_STUDIO_*` details. Vertex (#51) is the last
backend adapter still pending.

Currently registered scenarios (8): `compute-step` and
`adversarial-out-of-order` ship against the canonical `examples/sample-app/`;
`network-bug`, `console-error`, `event-binding`, `deep-source-map`,
`worker-bug`, and `conditional-bp` have committed per-scenario forks
under `evals/sample-app-variants/<name>/` and build via
`npm run sample:build` (`scripts/build-variants.mjs`).

## Wire into Claude Code

```sh
claude mcp add cdp-mcp node /absolute/path/to/dist/index.js
```

Or via `~/.claude.json`:

```json
{
  "mcpServers": {
    "cdp-mcp": { "command": "node", "args": ["/abs/path/dist/index.js"] }
  }
}
```

## End-to-end smoke (with a browser)

1. Install the sample app's deps and start it:
   ```sh
   cd examples/sample-app
   npm install
   npm run dev          # listens on :5173
   ```
2. In a Claude Code session with `cdp-mcp` enabled, ask:
   > Open localhost:5173 in a non-headless browser. Set a breakpoint at src/handlers.ts:7. Click #go. When it pauses, tell me what `step` is — and why the counter increments wrong.
3. The agent should chain: `launch_chrome` → `set_breakpoint` → `click` → `wait_for_pause` → `get_scope`/`evaluate` → `resume`, and conclude that `computeStep()` returns `2` instead of `1`.

## Tool conventions for agents

- **File coords are TS, 1-based lines, 0-based columns** unless the tool name ends in `_js` or takes a `script_id`.
- **Pause-only tools** (`get_call_stack`, `get_scope`, `evaluate` with `frame_index`): return `error: "not_paused"` if called outside a pause.
- **Buffered tools** (`get_console_logs`, `get_network_requests`): return a `cursor` (max `seq` seen). Pass it back as `since` to paginate.
- **Errors** come back as `isError: true` with a structured `{ error, message }` JSON payload.
- **Compact returns**: previews trimmed to ~200 chars, lists capped at sensible defaults — bodies lazy-loaded via dedicated tools.

## Programmatic contract (`cdp-mcp/contract`)

The structured `LocatorSpec` that `locate`, `wait_for`, and the form-driving tools
accept is published as a side-effect-free subpath export, so external tooling can
*produce and validate* specs without duplicating the shape or pulling in the CLI:

```ts
import { locatorSchema, parseLocator, serializeLocator } from "cdp-mcp/contract";
import type { LocatorSpec } from "cdp-mcp/contract";

const spec = parseLocator({ by: "role", role: "button", name: "Submit" });
locatorSchema.parse(spec);          // throws on an invalid shape
serializeLocator(spec);             // stable, normalized JSON
```

Exports: `LocatorSpec` (type), `LocatorBy`, `locatorSchema` / `locatorShape` /
`locatorBySchema` (Zod), and `normalizeLocator` / `parseLocator` / `serializeLocator`
/ `LocatorError`. This module imports only `zod`. The subpath is **ESM-only** (the
`exports` map defines `import`, not `require`) — consume it from an ESM module or a
bundler.

## Prior art

If `cdp-mcp` doesn't fit your workflow, look at:
- [`InDate/cdp-tools-mcp`](https://github.com/InDate/cdp-tools-mcp)
- [`ScriptedAlchemy/devtools-debugger-mcp`](https://github.com/ScriptedAlchemy/devtools-debugger-mcp) (Node-focused)
- [`ChromeDevTools/chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (automation + console, no breakpoints)

## Out of scope for v1

Firefox / Safari, Node.js debugging, `Storage.*`, `Tracing.*`, `HeapProfiler.*`, concurrent multi-page debugging.

See [design notes](docs/design-notes.md) — original plan snapshot + a section on what reviewer iteration discovered.
