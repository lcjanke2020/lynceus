# lynceus

[![npm](https://img.shields.io/npm/v/lynceus)](https://www.npmjs.com/package/lynceus)
[![CI](https://github.com/lcjanke2020/lynceus/actions/workflows/ci.yml/badge.svg)](https://github.com/lcjanke2020/lynceus/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/lcjanke2020/lynceus)](./LICENSE)
[![node](https://img.shields.io/node/v/lynceus)](https://www.npmjs.com/package/lynceus)
[![npm provenance](https://img.shields.io/badge/npm-provenance-brightgreen)](https://www.npmjs.com/package/lynceus)

A Model Context Protocol (MCP) server that exposes the Chrome DevTools Protocol (CDP) and the Node.js Inspector to AI agents as a **TypeScript-aware runtime debugger**.

Designed for agents running in CLIs (Claude Code, GitHub Copilot CLI) that have local source + source-map access. Coordinates flow in TS terms; the server translates to JS for CDP under the hood.

> **Formerly `cdp-mcp`** — renamed in 0.3.0: the server debugs both the browser **and** Node.js, so "CDP" undersold it (the name is the Argonauts' sharp-eyed lookout). Old repo links redirect, deprecated `CDP_MCP_*` env vars still work, and `npm install cdp-mcp` installs a compatibility wrapper that boots lynceus — history in [CHANGELOG.md](./CHANGELOG.md).

**Status:** alpha. **License:** [MIT](./LICENSE). Releases are published to npm by CI via [OIDC trusted publishing](https://docs.npmjs.com/generating-provenance-statements) — no long-lived npm token exists — with a provenance attestation linking the published tarball to the exact commit and workflow run that built it.

**Last updated: 2026-07-20**

## Install

Requires Node.js 20+ and a local Chrome/Chromium browser (for browser debugging; Node debugging needs no browser).

```sh
npm install -g lynceus
lynceus                           # stdio MCP transport (the default clients expect)
```

The npm package ships prebuilt `dist/`, so there is no build step for runtime use. If `launch_chrome` cannot find Chrome/Chromium automatically, set `CHROME_PATH` to the browser binary.

## Wire into Claude Code

If you installed globally from npm, no repo checkout is needed:

```sh
claude mcp add lynceus lynceus
```

(`lynceus --help` is a quick smoke test that the bin is on your PATH.)

Prefer no global install? Use npx (the `--` keeps `-y` for npx rather than the `claude` CLI):

```sh
claude mcp add lynceus -- npx -y lynceus
```

From a source checkout (`npm install && npm run build` first):

```sh
claude mcp add lynceus node /absolute/path/to/dist/index.js
```

Or via `~/.claude.json`:

```json
{
  "mcpServers": {
    "lynceus": { "command": "node", "args": ["/abs/path/dist/index.js"] }
  }
}
```

## Demo walkthrough

<!-- LEO-453: demo gif/asciinema of the breakpoint → pause → inspect flow embeds here,
     restoring this section's 60-second-demo framing. -->

The walkthroughs below use the repo's intentionally-buggy sample apps — but any localhost app of your own works the same way.

### Browser: breakpoint → pause → inspect

1. Get the sample app, install its deps, and start it:
   ```sh
   git clone https://github.com/lcjanke2020/lynceus.git
   cd lynceus/examples/sample-app
   npm install
   npm run dev          # listens on :5173
   ```
2. In a Claude Code session with `lynceus` enabled, ask:
   > Open localhost:5173 in a non-headless browser. Set a breakpoint at src/handlers.ts:7. Click #go. When it pauses, tell me what `step` is — and why the counter increments wrong.
3. The agent should chain: `launch_chrome` → `set_breakpoint` → `click` → `wait_for_pause` → `get_scope`/`evaluate` → `resume`, and conclude that `computeStep()` (the bug lives at `src/handlers.ts:12`) returns `2` instead of `1` — the line-7 breakpoint pauses in the caller right after that value lands in `step`.

### Node Inspector: attach or launch

Two flows against `examples/sample-node-app/` (the same fixture the e2e tests use).

**`attach_node` — agent attaches to an already-running Node process.** Build the fixture (from the repo root) and start it under the inspector in one terminal:

```sh
npm run sample-node:build
node --inspect-brk examples/sample-node-app/dist/index.js   # pauses at the first line; listens on 127.0.0.1:9229
```

In a Claude Code session with `lynceus` enabled, ask:
> Attach to the Node process on 127.0.0.1:9229. Set a breakpoint at `src/handlers.ts:2`. Resume and tell me what `name` is on the first hit.

The agent should chain: `attach_node` → entry pause → `set_breakpoint` → `resume` → `wait_for_pause` → `get_scope`, and report `name === "world"` from the paused frame.

**`launch_node` — agent owns the Node child end-to-end.** No separate terminal:

> Launch `examples/sample-node-app/dist/index.js` under `--inspect-brk`. Set a breakpoint at `src/handlers.ts:2`. Resume and tell me what `name` is on the first hit.

`close_session` terminates the child because lynceus launched it (`state.attached === false`); `attach_node` sessions leave the user's Node process alive.

### Full stack: one request, two debug sessions

This is the multi-session killer flow: one lynceus process keeps a browser and a Node
backend live together, with TypeScript breakpoints on both sides of the same `fetch`.
Prepare the planted cart-bug fixture and leave only its frontend dev server running:

```sh
npm run sample-fullstack:build
npm run --prefix examples/sample-fullstack-app dev   # http://127.0.0.1:5173
```

Then ask the agent:

> The cart badge stays at 0 after Add to cart. Launch
> `examples/sample-fullstack-app/server/dist/index.js` as a Node session labeled
> `backend`, and launch Chrome at `http://127.0.0.1:5173` as `frontend`. Keep both
> sessions live, set a TS/TSX breakpoint in each side of the add-to-cart path, follow
> one request into the backend, and tell me the root cause.

The expected spine is `launch_node` → drain its entry pause → backend breakpoint →
`resume` → `launch_chrome` → `list_sessions` → frontend breakpoint/pause → resume the
frontend → backend pause → inspect `req.body`. `list_sessions` should show `node_1` and
`browser_1` concurrently. Every follow-up passes the originating `session`; the two
targets can both return `bp_1` because breakpoint IDs are target-local. The reveal is
middleware ordering in `server/src/index.ts`: `express.json()` is registered after the
cart router, so the handler sees an unparsed body. The precise, timed narration lives
in [examples/sample-fullstack-app/DEMO.md](examples/sample-fullstack-app/DEMO.md).

### Inspector port security

`node --inspect` opens a debugger port with **full arbitrary-code-execution** capability against the V8 runtime — anyone who can reach the port can run code in your Node process. lynceus's defaults keep this safe in normal use, but the constraints are worth knowing:

- `attach_node` defaults to `127.0.0.1:9229`. Don't bind `--inspect=0.0.0.0` or a LAN/VPN interface unless you've thought hard about who can reach it.
- The source-map loader refuses `file://` reads when the inspector host is non-loopback (`src/sourcemap/loader.ts`) — a remote-debugging session can't trick lynceus into reading attacker-chosen local paths.
- Browser-only MCP tools (DOM, navigation, browser-network) return `unsupported_target` when the active session is Node, so an agent can't accidentally drive page-style automation against a backend process.

## What it gives an agent

Across 59 tools ([full catalog](./src/tools/README.md)):

- **Browser and Node launch/attach modes** — `launch_chrome` / `attach_chrome` for a browser target; `launch_node` / `attach_node` for a Node.js process under `--inspect` / `--inspect-brk`. The Runtime + Debugger surface (breakpoints, stepping, scopes, evaluate, console) is shared across both; browser-only tools (`navigate`, DOM, network, …) return `unsupported_target` in Node sessions.
- **Concurrent frontend + backend sessions** — one browser and one Node target may be live together. Launch/attach returns monotonic `browser_N` / `node_N` IDs, `list_sessions` exposes both lanes, and ordinary tools accept `session` for explicit routing. Omission stays convenient with one live target and returns `ambiguous_session` with two.
- **Breakpoints in TS source** — `set_breakpoint(file="src/foo.ts", line=42, condition?, log_message?)`. The server matches source maps and binds in every script that maps back to that file.
- **Stepping** — `step_over`, `step_into`, `step_out`, `resume`, `pause`, plus the authoritative sync point `wait_for_pause`.
- **Live inspection at a paused frame** — `get_call_stack`, `get_scope`, `evaluate` (frame-aware), `get_object_properties`. All call-stack frames are TS-mapped.
- **Buffered console + network + merged timeline** — specialized readers stay per-session; `get_timeline(session="all")` interleaves browser and Node events by registry-global `seq`. Bodies are lazy-loaded via `get_request_body` / `get_response_body`.
- **Light DOM interaction** — `query_selector`, `click`, `type_text`, `press_key`, `screenshot` so the agent can drive a flow to a breakpoint.
- **Structured DOM querying** — Playwright-inspired `locate` (LocatorSpec: CSS, text, role, test-id, label, placeholder, name), `wait_for` (poll until DOM state), `get_form_state` (read named form fields).
- **Form driving** — `fill`, `check` / `uncheck`, `select_option`, plus `suggest_locator` to get a robust semantic locator for an element.
- **Session portability** — `export_storage_state` / `load_storage_state` carry a logged-in session (cookies + localStorage) across runs; `get_cookies` / `set_cookies` read and set cookies directly (`get_cookies` redacts likely-auth / HttpOnly values for safe logging).
- **TS source + source-map diagnostics** — `get_source` (original TypeScript by file, the coordinates `set_breakpoint` uses), `list_scripts`, `resolve_source_position`, `get_script_source` (compiled JS).
- **React component inspection** — opt in with `attach_react_devtools`, then use `get_react_tree` for a bounded current snapshot, `find_react_component` for deterministic display-name lookup, and `inspect_react_component` for live dehydrated props/state/hooks/context plus best-effort mapped TypeScript source. V1 reads the main-frame tree only; production builds warn but still return available data.

Auto-attaches to iframes and workers via `Target.setAutoAttach({ flatten: true })`.

## Troubleshooting

- **`launch_chrome` can't find a browser** — set `CHROME_PATH` to your Chrome/Chromium binary (chrome-launcher reads it natively). On Linux, a Playwright-bundled Chromium works: `npx playwright install chromium`, then point `CHROME_PATH` at the installed binary.
- **How do I know it's working?** — `lynceus --help` proves the bin resolves; `claude mcp list` shows whether Claude Code connected to it. From a source checkout, `npm run smoke` verifies the protocol surface end-to-end with no browser.
- **SSE port already in use** — SSE mode binds the port you pass (`--port 9719` in the examples); pick another if it's taken. Note `9229` is the Node Inspector's default port, not lynceus's — don't hand `--port 9229` to the SSE transport while also debugging Node.
- **Ubuntu 23.10+ / AppArmor sandbox errors** — Ubuntu's user-namespace restrictions can break Chromium's sandbox. `launch_chrome` defaults to `--no-sandbox` for exactly this reason; if you want the sandbox **on**, see [`docs/chromium-sandboxing.md`](docs/chromium-sandboxing.md) for the AppArmor profile setup.
- **Windows** — the unit and contract test layers work natively, but `chrome-launcher` 1.2.1 fails to bind its own port on Windows 11 (ECONNREFUSED in its startup poll), which affects local browser e2e runs and can affect `launch_chrome`. Run under WSL2 (Ubuntu) for browser work, or `attach_chrome` to a manually-started Chrome. Note Chrome 136+ ignores `--remote-debugging-port` on the default profile — pair it with a throwaway `--user-data-dir`:
  ```bat
  start chrome --remote-debugging-port=9222 --user-data-dir="%TEMP%\lynceus-debug-profile"
  ```
  (a separate profile, so your usual logins/extensions won't be present).

## Tool conventions for agents

- **File coords are TS, 1-based lines, 0-based columns** unless the tool name ends in `_js` or takes a `script_id`.
- **`session` and `session_id` are different axes.** `session` selects a debug target (`browser_1` / `node_1`); `session_id` round-trips a CDP child (worker/iframe/OOPIF) inside that target, with `null` meaning root. Omit `session` only when one target is live.
- **Pause-only tools** (`get_call_stack`, `get_scope`, `evaluate` with `frame_index`): return `error: "not_paused"` if called outside a pause.
- **Unscoped `wait_for_pause` races live targets.** With both kinds live, omission means “first participant to pause”; pass `session` for a scoped wait. `get_timeline(session="all")` is the corresponding merged event read.
- **Buffered tools** (`get_console_logs`, `get_network_requests`): return a `cursor` (max `seq` seen). Pass it back as `since` to paginate.
- **Errors** come back as `isError: true` with a structured `{ error, message }` JSON payload.
- **Compact returns**: previews trimmed to ~200 chars, lists capped at sensible defaults — bodies lazy-loaded via dedicated tools.

## Programmatic contract (`lynceus/contract`)

The structured `LocatorSpec` that `locate`, `wait_for`, and the form-driving tools accept is published as a side-effect-free subpath export, so external tooling can *produce and validate* specs without duplicating the shape or pulling in the CLI:

```ts
import { locatorSchema, parseLocator, serializeLocator } from "lynceus/contract";
import type { LocatorSpec } from "lynceus/contract";

const spec = parseLocator({ by: "role", role: "button", name: "Submit" });
locatorSchema.parse(spec);          // throws on an invalid shape
serializeLocator(spec);             // stable, normalized JSON
```

Exports: `LocatorSpec` (type), `LocatorBy`, `locatorSchema` / `locatorShape` / `locatorBySchema` (Zod), and `normalizeLocator` / `parseLocator` / `serializeLocator` / `LocatorError`. This module imports only `zod`. The subpath is **ESM-only** (the `exports` map defines `import`, not `require`) — consume it from an ESM module or a bundler.

## SSE transport and persistent service mode

stdio is the default transport (it's what Claude Code launches). For MCP clients that support SSE:

```sh
lynceus --port 9719               # SSE MCP transport on 127.0.0.1:9719
lynceus --host 0.0.0.0 --port 9719 --allow-remote
```

You can run `lynceus` as a persistent local service — [macOS launchd](docs/launchd-service.md) or [Linux systemd](docs/systemd-service.md) user service. Service mode keeps the process and its current browser/Node sessions alive across MCP client restarts or reconnects. It does **not** persist state across service-process restarts.

SSE caveats:

- **Single-tenant registry.** Every `/sse` connection gets its own `McpServer`, but all connections share the process-global `SessionRegistry`. The registry safely separates its browser and Node records; it does **not** isolate clients. One client can list, pause, resume, inspect, or close sessions launched by another, and same-kind launch capacity is shared. Do not expose one service instance to mutually untrusted clients; call `list_sessions` and close explicitly when a reconnect should start fresh.
- **Non-loopback bind requires opt-in.** `--allow-remote` (or `LYNCEUS_ALLOW_REMOTE=1`, or the deprecated `CDP_MCP_ALLOW_REMOTE=1`) is required to bind to anything other than loopback. MCP tools include `evaluate` (in-page code exec), a `screenshot path=` filesystem write, `export_storage_state` (writes full cookie values — including HttpOnly auth secrets — to a server-side file) and `load_storage_state` (reads an arbitrary server-side file); the gate makes remote exposure a deliberate operator decision rather than a default.
- **Host / Origin headers are validated on loopback binds** to block DNS-rebinding against `127.0.0.1` / `localhost` / `[::1]`. On non-loopback binds the operator has already accepted exposure via `--allow-remote`, and the server can't statically enumerate every hostname/IP a LAN/VPN/DNS client might reach it by — those checks are skipped. If you need per-`Host` policy on a LAN/WAN deployment, front the server with a reverse proxy that enforces it.

## Development and testing

```sh
npm install
npm run build
node dist/index.js                    # run the built server on stdio
```

The test pyramid has four layers (see [docs/test-eval-plan.md](docs/test-eval-plan.md) for the full design):

```sh
npm test              # L1 unit + L2 tool-contract (fake CDP) + L4 harness-unit tests — seconds, no browser, no LLM
npm run typecheck     # both tsconfigs — CI gates on this
npm run smoke         # stdio protocol smoke, no browser — CI gates on this
npm run test:e2e      # L3: real headless Chromium + real Node Inspector, 21 specs
npm run eval:quick    # L4: 1 LLM-agent scenario × 1 trial (needs ANTHROPIC_API_KEY; ~$0.50–2 at the default Opus-4.8-medium)
npm run eval:quick:fullstack  # L4: fullstack-cart dual-target scenario × 1 trial
npm run eval:quick:react      # L4: 2 React-inspection scenarios × 1 trial each
npm run eval          # L4: all 21 scenarios × 3 trials (cost data in evals/README.md; EVAL_BUDGET_USD caps a run, default $100)
```

- **L3 e2e** drives the browser-facing tools against a real Chromium attached to a built `examples/sample-app/`, Node Inspector attach/launch flows against `examples/sample-node-app/`, and one full-stack acceptance flow that keeps both sessions live across the same request. Browser selection (`CDP_TEST_BROWSER`, default `chromium`) and the per-OS resolver matrix are documented in [docs/test-eval-plan.md §Layer 3](docs/test-eval-plan.md); the step-by-step local setup (Playwright Chromium + AppArmor profile for sandbox-**on** runs) is [docs/local-l3-e2e-setup.md](docs/local-l3-e2e-setup.md). Chromium-only failures land with a `// @chromium-skip — <gap-id>` comment plus a row in [docs/known-chromium-gaps.md](docs/known-chromium-gaps.md) — `npm run lint:chromium-skips` enforces this. `launch_chrome` defaults to `--no-sandbox`; see [docs/chromium-sandboxing.md](docs/chromium-sandboxing.md) before changing that.
- **L4 agent evals** drive the lynceus tool surface through a real LLM agent — 21 scenarios (16 browser, including 2 React-inspection cases, + 4 Node + `fullstack-cart`, the first dual target), six vendor adapters selected via `EVAL_PROVIDER` (Anthropic default; OpenAI, Vertex/Gemini, DeepSeek, Moonshot/Kimi, LM Studio), deterministic NDJSON-trace oracles (no LLM judge), per-run cost caps. Always launch through the npm scripts (`npm run eval`, `npm run eval:quick`, `npm run eval:quick:node`, `npm run eval:quick:fullstack`, `npm run eval:quick:react`) so their pre-hooks rebuild the server and script-specific fixtures; the static browser variants still need the one-time `npm run sample:build` documented in [evals/README.md](evals/README.md). Calling `tsx evals/cli.ts` directly skips all pre-hooks. Model/reasoning/cost env knobs, scenario table, caching behavior, and trace format live there too.

Contributions: see [CONTRIBUTING.md](./CONTRIBUTING.md); repo map in [INDEX.md](./INDEX.md); security reports via [SECURITY.md](./SECURITY.md).

## Prior art

If `lynceus` doesn't fit your workflow, look at:
- [`InDate/cdp-tools-mcp`](https://github.com/InDate/cdp-tools-mcp)
- [`ScriptedAlchemy/devtools-debugger-mcp`](https://github.com/ScriptedAlchemy/devtools-debugger-mcp) (Node-focused)
- [`ChromeDevTools/chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (automation + console, no breakpoints)

## Out of scope for v1

Firefox / Safari, `Storage.*`, `Tracing.*`, `HeapProfiler.*`, concurrent multi-page debugging, and multi-process Node (Worker threads / `cluster` children — Worker-domain auto-attach is deferred per [`docs/node-session-design.md`](docs/node-session-design.md) §9). Single-process Node debugging **is** in scope via `attach_node` / `launch_node`.

See [design notes](docs/design-notes.md) — original plan snapshot + a section on what reviewer iteration discovered.
