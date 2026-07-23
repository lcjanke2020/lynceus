# INDEX.md

**Last updated: 2026-07-20**

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
| [CHANGELOG.md](./CHANGELOG.md) | Per-release notable changes, 0.1.0 → current (0.2.2 and earlier shipped as `cdp-mcp`). |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev loop (test/typecheck/smoke), PR conventions, new-tool checklist pointer. |
| [INDEX.md](./INDEX.md) | This file. |
| [README.md](./README.md) | Install, wire into Claude Code, demo walkthrough, troubleshooting, tool conventions, SSE/service mode. |
| [SECURITY.md](./SECURITY.md) | Security model + vulnerability reporting: transport/network exposure, the agent-operator (prompt-injection → action) threat, and deployment hardening. |

### docs/

| File | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Component diagram, layered view, request-flow sequences, session state machine, test-pyramid diagram. |
| [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) | Canonical `--no-sandbox` / `sandbox: true` guidance: Chromium sandbox, AppArmor, unprivileged user namespaces, snap confinement, and Bubblewrap. |
| [docs/local-l3-e2e-setup.md](./docs/local-l3-e2e-setup.md) | Step-by-step runbook to get local `npm run test:e2e` passing sandbox-on on Ubuntu: install Playwright Chromium, verify the resolver, attach the `lynceus-chromium` AppArmor `userns` profile, with the `CI=1` `--no-sandbox` fallback. |
| [docs/design-notes.md](./docs/design-notes.md) | Original design plan + a "What the implementation discovered" section (source-map line numbering, CRI typed-send trap, sessionId multi-target complexity). |
| [docs/node-session-design.md](./docs/node-session-design.md) | Design doc for adding Node.js Inspector support: `SessionState.kind`, the shared `debugger.ts` module split, the capability-gating mechanism (`unsupported_target`), the Node source-map loader tier, and a worked end-to-end example. Locks the browser/Node session-kind contract. |
| [docs/dual-target-debugging.md](./docs/dual-target-debugging.md) | Design doc for concurrent browser + Node sessions (multi-session): the `session` addressing model (`browser_N`/`node_N` ids + labels, `ambiguous_session`), the `SessionRegistry` (reserve → activate lifecycle), scoped/raced `wait_for_pause`, the `get_timeline` merged view over global `seq`, the `session` vs CDP-child `session_id` disambiguation table, and the full-stack cart-bug worked example. |
| [docs/node-test-coverage-proposal.md](./docs/node-test-coverage-proposal.md) | Proposal for the Node test-coverage epic: the new L3 Node e2e specs, the 4 L4 Node scenarios (`node-compute-step`, `node-stdio-bug`, `node-conditional-bp`, `node-uncaught-throw`), the harness Node-target seam (`Scenario.target` discriminator + runner branch + `cli.ts` / `RunTrialOpts` / `ScenarioStartEntry` contract extensions), and the `eval:quick:node` smoke hook. Implemented; the text is preserved for the design rationale and cost/sequencing plan. |
| [docs/launchd-service.md](./docs/launchd-service.md) | macOS launchd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/systemd-service.md](./docs/systemd-service.md) | Linux systemd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/test-eval-plan.md](./docs/test-eval-plan.md) | The living test/eval spec — 4-layer pyramid, the fake-CDP contract layer (`test/fake-cdp.ts`), L4 cost model, **11 Critical Gotchas** every author has to know. |
| [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md) | Per-spec Chromium-vs-Chrome gaps (table grows as gaps surface) + host-OS workarounds (Windows 11 chrome-launcher ECONNREFUSED, WSL2 snap-Chromium). |
| [docs/react-devtools-design.md](./docs/react-devtools-design.md) | React DevTools integration design + spike findings (S2–S6) — the authority doc for RDT-1..6 (LEO-359..364): bridge recipe, lifecycle/event model, cross-version matrix + support floor, tool surface, synthesis + reconciliation ledger. |

### Component READMEs

| File | What it covers |
|---|---|
| [src/session/README.md](./src/session/README.md) | `SessionRegistry`, browser + Node concurrent lifecycle, addressing, per-target `PauseTracker`/buffers/maps, global sequencing, capability gating. |
| [src/sourcemap/README.md](./src/sourcemap/README.md) | `ScriptStore`, lazy kind-aware source-map loading (browser via `Network.loadNetworkResource`; Node via `file://` read), TS↔JS coordinate translation, path normalization. |
| [src/tools/README.md](./src/tools/README.md) | `registerJsonTool` pattern, structured error envelope, full 54-tool catalog with browser/Node/shared kind column. |
| [evals/README.md](./evals/README.md) | L4 LLM-agent eval harness, multi-vendor `VendorAdapter` seam, browser/Node/dual `Scenario.target` shapes, oracle/grader, fixture lifecycle, cost + caching. |
| [examples/sample-app/README.md](./examples/sample-app/README.md) | Shared browser test fixture (Vite + TS), intentional bugs, how to run standalone. |
| [examples/sample-node-app/README.md](./examples/sample-node-app/README.md) | Shared Node Inspector test fixture (multi-entry tsc-compiled ESM): seven source files — six runnable entries (`index`, `compute-step`, `throw`, `stdio-bug`, `conditional-bp`, `fullstack-api`) plus the shared helper `handlers.ts` — driving the L3 Node and dual-session e2e specs + 4 L4 Node scenarios. |
| [examples/sample-fullstack-app/README.md](./examples/sample-fullstack-app/README.md) | Full-stack demo + L4 fixture: dev-build React FE + Express BE with the planted body-parser-ordering cart bug; `DEMO.md` is the dual-session interview script and `fullstack-cart` drives it in the eval harness. |
| [wrapper/cdp-mcp/README.md](./wrapper/cdp-mcp/README.md) | Tombstone README for the published `cdp-mcp` npm compatibility wrapper: rename notice + migration paragraph. |

## Code map

Entry points:

| File | Role |
|---|---|
| [`src/index.ts`](./src/index.ts) | Stdio MCP server lifecycle (SIGINT/SIGTERM shutdown). What Claude Code launches. |
| [`src/server.ts`](./src/server.ts) | `buildServer()` — instantiates `McpServer`, calls each `registerXxxTools(server)`. |
| [`src/contract.ts`](./src/contract.ts) | Published `lynceus/contract` subpath export — a thin barrel re-exporting the `LocatorSpec` type + Zod `locatorSchema` / `parseLocator` / `serializeLocator` from [`src/locator.ts`](./src/locator.ts) (the source of truth). ESM-only, depends only on `zod`. |

Source tree:

| Directory | What's in it | README |
|---|---|---|
| `src/session/` | `SessionRegistry` (one browser + one Node record; `browser_N` / `node_N` addressing; global event `seq`), per-record `SessionState`, `browser.ts` / `node.ts` lifecycle, shared `debugger.ts`, capability gates, `PauseTracker`, console/network/Node-output ring buffers, and transactional reserve → activate/abort teardown. | [README](./src/session/README.md) |
| `src/sourcemap/` | `ScriptStore` (compound key `sessionId+scriptId`), kind-aware `buildScriptParsedHandler` / source-map loader (browser → `Network.loadNetworkResource` with `fetch()` fallback; Node → `fs.readFile(fileURLToPath(url))` gated to loopback inspector hosts), `mapCdpToOriginal` / `mapOriginalToGenerated`, `normalizeSourcePath` / `pathMatches`. | [README](./src/sourcemap/README.md) |
| `src/tools/` | 54 MCP tools across 13 files: `session` (incl. `launch_chrome` / `attach_chrome` / `launch_node` / `attach_node`), `nav`, `source`, `breakpoints`, `execution`, `inspect`, `console`, `network`, `dom` (incl. structured `locate` / `wait_for` / `get_form_state` LocatorSpec tools), `forms`, `storage`, `node-output` (Node-only `get_node_output`), and `timeline` (cross-session `get_timeline`). Plus `_register.ts`, `_session_input.ts`, and `_locator_runtime.ts` (helpers). | [README](./src/tools/README.md) |
| `src/util/` | `errors.ts` (`ToolError`, `noSession()`, `notPaused()`, `alreadySession()`, `ambiguousSession()`, `unknownSession()`, `duplicateLabel()`, `unsupportedTarget()`), `format.ts` (`previewRemoteObject`, `truncate`, `describeRemote`, `toolJson`, `toolText`), `log.ts` (structured stderr logging). | — |
| `test/` | L2 contract tests (`test/tools/*.test.ts` against `test/fake-cdp.ts`), L3 e2e (`test/e2e/*.test.ts` — 11 browser specs + 7 Node specs + 1 dual-session full-stack spec + the `eval-runner-node` harness spec (20 total), against real Chromium and Node `--inspect`). | [docs/test-eval-plan.md](./docs/test-eval-plan.md) |
| `evals/` | L4 harness — `evals/cli.ts` + `evals/harness/` (multi-vendor `VendorAdapter` adapters plus `model`/`runner`/`grader`/`trace`/`mcp-client`, static + managed dev servers, retry/sandbox/types) + 19 scenarios (14 browser + 4 Node + the dual `fullstack-cart`, dispatched by `Scenario.target`) + browser variants. | [README](./evals/README.md) |
| `examples/sample-app/` | Vite + TS web app — the browser-side breakpoint-debug fixture. | [README](./examples/sample-app/README.md) |
| `examples/sample-node-app/` | tsc-compiled ESM Node fixture — seven source files sharing one `dist/`: six runnable entries (`index.ts`, `compute-step.ts`, `throw.ts`, `stdio-bug.ts`, `conditional-bp.ts`, `fullstack-api.ts`) plus the shared helper `handlers.ts` (imported by `index.ts`). Backs L3 Node/dual-session e2e + L4 Node scenarios. | [README](./examples/sample-node-app/README.md) |
| `examples/sample-fullstack-app/` | Dev-build React FE (Vite, React 18.3.1 exact) + Express BE (tsc + source maps) with the planted cart bug — the dual-session demo app, `DEMO.md` script, and `fullstack-cart` L4 target. | [README](./examples/sample-fullstack-app/README.md) |
| `scripts/` | `smoke.mjs`, `check-chromium-skips.mjs`, `build-variants.mjs`; fixture build entry points live in root `package.json`. | — |
| `wrapper/cdp-mcp/` | The published `cdp-mcp` compat wrapper (npm shim over lynceus): `bin.js` boots the lynceus entry in-process, `index.js`/`contract.js` re-export the lynceus subpaths, `smoke-test.mjs` verifies against the *published* lynceus (standalone `npm install`, not part of the vitest suite). | [README](./wrapper/cdp-mcp/README.md) |
