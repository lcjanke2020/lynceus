# INDEX.md

**Last updated: 2026-07-06**

Where to find everything in this repo.

## Reading order for a new agent

1. **[AGENTS.md](./AGENTS.md)** — current state, what's actively shipping, conventions.
2. **[README.md](./README.md)** — install, build, wire into Claude Code, smoke test.
3. **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — how the parts fit; component / sequence / state diagrams.
4. **[docs/test-eval-plan.md](./docs/test-eval-plan.md) §Critical gotchas** — the 11 gotchas you will eventually trip on.
5. The component README that matches what you're touching (table below).

## Doc map

### Root

| File | What it covers |
|---|---|
| [AGENTS.md](./AGENTS.md) | Agent on-ramp: mission, current events, conventions, where-to-look. |
| [INDEX.md](./INDEX.md) | This file. |
| [README.md](./README.md) | Install, build, wire into Claude Code, smoke test, tool conventions. |
| [SECURITY.md](./SECURITY.md) | Security model + vulnerability reporting: transport/network exposure, the agent-operator (prompt-injection → action) threat, and deployment hardening. |

### docs/

| File | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Component diagram, layered view, request-flow sequences, session state machine, test-pyramid diagram. |
| [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) | Canonical `--no-sandbox` / `sandbox: true` guidance: Chromium sandbox, AppArmor, unprivileged user namespaces, snap confinement, and Bubblewrap. |
| [docs/local-l3-e2e-setup.md](./docs/local-l3-e2e-setup.md) | Step-by-step runbook to get local `npm run test:e2e` passing sandbox-on on Ubuntu: install Playwright Chromium, verify the resolver, attach the `cdp-mcp-chromium` AppArmor `userns` profile, with the `CI=1` `--no-sandbox` fallback. |
| [docs/design-notes.md](./docs/design-notes.md) | Original design plan + a "What the implementation discovered" section (source-map line numbering, CRI typed-send trap, sessionId multi-target complexity). |
| [docs/node-session-design.md](./docs/node-session-design.md) | Design doc for adding Node.js Inspector support: `SessionState.kind`, the shared `debugger.ts` module split, the capability-gating mechanism (`unsupported_target`), the Node source-map loader tier, and a worked end-to-end example. Locks the browser/Node session-kind contract. |
| [docs/node-test-coverage-proposal.md](./docs/node-test-coverage-proposal.md) | Proposal for the Node test-coverage epic: the new L3 Node e2e specs, the 4 L4 Node scenarios (`node-compute-step`, `node-stdio-bug`, `node-conditional-bp`, `node-uncaught-throw`), the harness Node-target seam (`Scenario.target` discriminator + runner branch + `cli.ts` / `RunTrialOpts` / `ScenarioStartEntry` contract extensions), and the `eval:quick:node` smoke hook. Implemented; the text is preserved for the design rationale and cost/sequencing plan. |
| [docs/launchd-service.md](./docs/launchd-service.md) | macOS launchd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/systemd-service.md](./docs/systemd-service.md) | Linux systemd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/test-eval-plan.md](./docs/test-eval-plan.md) | The living test/eval spec — 4-layer pyramid, the fake-CDP contract layer (`test/fake-cdp.ts`), L4 cost model, **11 Critical Gotchas** every author has to know. |
| [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md) | Per-spec Chromium-vs-Chrome gaps (table grows as gaps surface) + host-OS workarounds (Windows 11 chrome-launcher ECONNREFUSED, WSL2 snap-Chromium). |

### Component READMEs

| File | What it covers |
|---|---|
| [src/session/README.md](./src/session/README.md) | `sessionState` singleton, browser + Node lifecycle, `PauseTracker`, ring buffers, capability gating. |
| [src/sourcemap/README.md](./src/sourcemap/README.md) | `ScriptStore`, lazy kind-aware source-map loading (browser via `Network.loadNetworkResource`; Node via `file://` read), TS↔JS coordinate translation, path normalization. |
| [src/tools/README.md](./src/tools/README.md) | `registerJsonTool` pattern, structured error envelope, full 51-tool catalog with browser/Node/shared kind column. |
| [evals/README.md](./evals/README.md) | L4 LLM-agent eval harness, multi-vendor `VendorAdapter` seam, scenario shape (browser + Node via `Scenario.target`), oracle/grader, cost + caching. |
| [examples/sample-app/README.md](./examples/sample-app/README.md) | Shared browser test fixture (Vite + TS), intentional bugs, how to run standalone. |
| [examples/sample-node-app/README.md](./examples/sample-node-app/README.md) | Shared Node Inspector test fixture (multi-entry tsc-compiled ESM): six source files — five runnable entries (`index`, `compute-step`, `throw`, `stdio-bug`, `conditional-bp`) plus the shared helper `handlers.ts` — driving the L3 Node e2e specs + 4 L4 Node scenarios. |

## Code map

Entry points:

| File | Role |
|---|---|
| [`src/index.ts`](./src/index.ts) | Stdio MCP server lifecycle (SIGINT/SIGTERM shutdown). What Claude Code launches. |
| [`src/server.ts`](./src/server.ts) | `buildServer()` — instantiates `McpServer`, calls each `registerXxxTools(server)`. |
| [`src/contract.ts`](./src/contract.ts) | Published `cdp-mcp/contract` subpath export — a thin barrel re-exporting the `LocatorSpec` type + Zod `locatorSchema` / `parseLocator` / `serializeLocator` from [`src/locator.ts`](./src/locator.ts) (the source of truth). ESM-only, depends only on `zod`. |

Source tree:

| Directory | What's in it | README |
|---|---|---|
| `src/session/` | `sessionState` singleton (with `kind: "browser" \| "node"`), `state.ts`, `browser.ts` (`launchChrome` / `attachChrome` / `closeSession` / `switchTarget`), `node.ts` (`attachNode` / `launchNode`), shared `debugger.ts` (`connectDebugger`), `capabilities.ts` (`TOOL_KIND_SUPPORT` + `requireCapable()`), `PauseTracker`, `RingBuffer<ConsoleEntry \| NetworkEntry>`, durable `nodeOutput` buffer for `launch_node`-owned stdio. | [README](./src/session/README.md) |
| `src/sourcemap/` | `ScriptStore` (compound key `sessionId+scriptId`), kind-aware `buildScriptParsedHandler` / source-map loader (browser → `Network.loadNetworkResource` with `fetch()` fallback; Node → `fs.readFile(fileURLToPath(url))` gated to loopback inspector hosts), `mapCdpToOriginal` / `mapOriginalToGenerated`, `normalizeSourcePath` / `pathMatches`. | [README](./src/sourcemap/README.md) |
| `src/tools/` | 51 MCP tools across 12 files: `session` (incl. `launch_chrome` / `attach_chrome` / `launch_node` / `attach_node`), `nav`, `source`, `breakpoints`, `execution`, `inspect`, `console`, `network`, `dom` (incl. structured `locate` / `wait_for` / `get_form_state` LocatorSpec tools), `forms`, `storage`, `node-output` (Node-only `get_node_output`). Plus `_register.ts` and `_locator_runtime.ts` (helpers). | [README](./src/tools/README.md) |
| `src/util/` | `errors.ts` (`ToolError`, `noSession()`, `notPaused()`, `alreadySession()`, `unsupportedTarget()`), `format.ts` (`previewRemoteObject`, `truncate`, `describeRemote`, `toolJson`, `toolText`), `log.ts` (structured stderr logging). | — |
| `test/` | L2 contract tests (`test/tools/*.test.ts` against `test/fake-cdp.ts`), L3 e2e (`test/e2e/*.test.ts` — 11 browser specs + 7 Node specs + the `eval-runner-node` harness spec (19 total), against real Chromium and Node `--inspect`). | [docs/test-eval-plan.md](./docs/test-eval-plan.md) |
| `evals/` | L4 harness — `evals/cli.ts` + `evals/harness/` (the `VendorAdapter` seam in `vendor.ts` + per-vendor adapters `anthropic`, `openai-adapter`/`openai-responses-adapter`/`openai-compat-adapter`, `vertex-adapter`, `deepseek-adapter`, `moonshot-adapter`, `lm-studio-adapter`, plus `model`/`runner`/`grader`/`trace`/`mcp-client`/`static-server`/`with-retry`/`types`) + scenarios (`evals/scenarios/*.ts` — 14 browser + 4 Node, dispatched by `Scenario.target`) + per-scenario variants (`evals/sample-app-variants/<name>/`). | [README](./evals/README.md) |
| `examples/sample-app/` | Vite + TS web app — the browser-side breakpoint-debug fixture. | [README](./examples/sample-app/README.md) |
| `examples/sample-node-app/` | tsc-compiled ESM Node fixture — six source files sharing one `dist/`: five runnable entries (`index.ts`, `compute-step.ts`, `throw.ts`, `stdio-bug.ts`, `conditional-bp.ts`) plus the shared helper `handlers.ts` (imported by `index.ts`). Backs L3 Node e2e + L4 Node scenarios. | [README](./examples/sample-node-app/README.md) |
| `scripts/` | `smoke.mjs`, `check-chromium-skips.mjs`, `build-variants.mjs`. | — |
