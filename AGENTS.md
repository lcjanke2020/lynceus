# AGENTS.md

**Last updated: 2026-07-06**

Quick-boot for AI agents (Claude Code, GitHub Copilot CLI, Codex CLI, …) dropped into this repo. Read this end-to-end before doing anything else.

## What this project is

`lynceus` is a Model Context Protocol (MCP) server that exposes the Chrome DevTools Protocol (CDP) to AI agents as a **TypeScript-aware frontend debugger**. 52 tools across 12 categories: session lifecycle, navigation, source, breakpoints, execution stepping, paused-frame inspection, buffered console, buffered network, structured DOM driving, form driving, session-portability (cookies + storage state), and Node-process output. Both **browser** (Chrome / Chromium) and **Node.js Inspector** sessions are first-class via `launch_chrome` / `attach_chrome` and `launch_node` / `attach_node`; the Runtime + Debugger surface is shared across both, and browser-only / Node-only tools gate via the `unsupported_target` envelope. Supports stdio and SSE transports. Coordinates flow in TS terms; the server resolves source maps and translates to JS for CDP under the hood. Designed for agents in CLIs that already have local source + source maps. The production server has no LLM dependency — `@anthropic-ai/sdk`, `@google/genai`, and the raw-fetch OpenAI/LM-Studio clients are used only by the L4 evals, where they sit behind a vendor-agnostic `VendorAdapter` seam so the five production vendors (Anthropic + OpenAI + Vertex + DeepSeek + Moonshot/Kimi) and the LM Studio reference adapter share one runner.

## Read first

- **[INDEX.md](./INDEX.md)** — full doc map + code map. One stop for "where do I find X."
- **[README.md](./README.md)** — install, build, wire into Claude Code, smoke test (with the compute-step example end-to-end).
- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — component diagram, sequence diagrams, session state machine. Read before changing anything load-bearing.

## Project status

The L1 → L4 test pyramid is in place and the L4 agent-eval harness is multi-vendor end-to-end. **Node.js Inspector sessions are first-class** alongside browser sessions — `launch_node` / `attach_node`, a shared Runtime + Debugger surface, capability-gated browser-only tools, and the Node-only `get_node_output` buffer — with L2 / L3 / L4 coverage on the load-bearing debug subset (breakpoints, stepping, exceptions, conditional breakpoints, console + stdio). The runner sits behind a vendor-agnostic `VendorAdapter` seam, with production adapters for Anthropic, OpenAI (GPT-class), Google Vertex (Gemini), DeepSeek, and Moonshot/Kimi, plus an LM Studio reference adapter for local models — all sharing one runner and a vendor-namespaced pricing catalog. NDJSON traces are `provider`-tagged with vendor-keyed `cacheTokens`. The production MCP server itself has no LLM dependency.

## Where to look

| If you're touching… | Read |
|---|---|
| Browser lifecycle, pause state, console/network buffers | [src/session/README.md](./src/session/README.md) |
| TS↔JS coordinate translation, script parsing, source maps | [src/sourcemap/README.md](./src/sourcemap/README.md) |
| Any MCP tool (adding, fixing, naming, schemas) | [src/tools/README.md](./src/tools/README.md) |
| L4 agent evals (scenarios, harness, oracle, cost) | [evals/README.md](./evals/README.md) |
| The shared test web app | [examples/sample-app/README.md](./examples/sample-app/README.md) |
| Chromium launch security, `--no-sandbox`, AppArmor, Bubblewrap | [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) |
| Getting local `npm run test:e2e` passing sandbox-on (Playwright Chromium + AppArmor profile) | [docs/local-l3-e2e-setup.md](./docs/local-l3-e2e-setup.md) |
| Debugging a flaky/failed test | [docs/test-eval-plan.md](./docs/test-eval-plan.md) §Critical gotchas — **mandatory** before debugging any test |
| A test fails on macOS/Windows but passes on Linux | [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md) |
| Original design rationale + post-implementation discoveries | [docs/design-notes.md](./docs/design-notes.md) |
| Node.js Inspector session-mode design (`SessionState.kind`, module split, capability gating) | [docs/node-session-design.md](./docs/node-session-design.md) |
| L3 e2e + L4 eval coverage shape for Node sessions | [docs/node-test-coverage-proposal.md](./docs/node-test-coverage-proposal.md) |
| `examples/sample-node-app/` — shared Node fixture (5 runnable entries — `index`, `compute-step`, `throw`, `stdio-bug`, `conditional-bp` — plus the shared helper `handlers.ts`) | [examples/sample-node-app/README.md](./examples/sample-node-app/README.md) |

## Eval run storage

The local `evals/runs/<run-id>/` directory is `.gitignore`d and not durable across machine reinstalls. Once a real-money run completes (anything beyond an `eval:quick` smoke check), archive the run dir somewhere durable (object storage, a synced folder, or a CI artifact store) so the trace survives and can be referenced later.

Each run dir should carry, in addition to the harness-produced `*-trial-*.ndjson` + `*-trial-*.thinking.ndjson` files: `git_state.txt` (commit SHA), `env_versions.txt` (node / SDK / Chrome), `env_config.txt` (EVAL_* envs used), `console.log` (full stderr from `npm run eval`), and a short `README.txt` summarizing the run.

## Conventions

### Branches

- Agent-driven feature work: `agents/<short-slug>` (e.g. `agents/l4-evals`, `agents/eval-model-rotation-proposal`).
- Bug-fix branches: `fixes/<slug>` (e.g. `fixes/docs-a0d61a`).
- `master` is the integration branch; PRs are squash-merged.

### Commits

- Conventional Commits: `<type>: <subject>`. Types in use: `feat`, `fix`, `docs`, `test`, `test+eval`, `chore`.
- The squash commit gets `(#NN)` appended for the PR number.

### PRs

- L1 + L2 must pass (`npm test`) for any code change.
- L3 (`npm run test:e2e`) must pass on the primary host (Linux ARM64 + Chromium). Documented host gaps live in [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md).

### Adding a new MCP tool

Five-step pattern (full detail in [src/tools/README.md](./src/tools/README.md)):

1. Define the Zod input schema with `.describe()` strings (those strings are what the model sees).
2. Write the handler. Use `requireSession()` always; `requirePaused()` for pause-only tools.
3. Wrap with `registerJsonTool(server, name, description, schema, handler)` — gives you the structured `{ error, message }` envelope and stderr logging for free.
4. Wire into the appropriate `registerXxxTools(server)`; add a new `registerXxxTools` call to `src/server.ts` only if it's a new category.
5. Add an L2 contract test in `test/tools/<file>.test.ts` against the fake-CDP, and a row in `src/tools/README.md` catalog.

### Coordinates and session IDs

- File coordinates are **TS**, **1-based lines**, **0-based columns** unless the tool name ends in `_js` or takes a `script_id`. Translation happens at the boundary via `src/sourcemap/store.ts`.
- Every CDP-minted ID (`object_id`, `script_id`, `request_id`, `call_frame_id`) is per-Debugger/Runtime/Network-agent — i.e., per flat session. Every tool that returns one of these IDs also returns the originating `session_id` (`null` for root). Round-trip it on follow-ups, or your call hits the wrong session.

## Out of scope (v1)

Firefox / Safari, `Storage.*`, `Tracing.*`, `HeapProfiler.*`, concurrent multi-page debugging, and multi-process Node (Worker threads / `cluster` children — Worker-domain auto-attach is deferred per [`docs/node-session-design.md`](./docs/node-session-design.md) §9). Single-process Node debugging **is** in scope via `attach_node` and `launch_node`. See [README §Out of scope](./README.md).

## Stuck? Try this first

- **`step_over` returns `paused: false` but session is paused** → entry-guard race; see `src/session/pause.ts` `waitForPauseOrResume()` and [docs/test-eval-plan.md](./docs/test-eval-plan.md) §Critical gotchas.
- **Breakpoint doesn't bind / `no_mapping` error** → call `list_scripts` (which scripts loaded?) and `resolve_source_position` (where does the source map place this line?). The `mapOriginalToGenerated` comment in `src/sourcemap/store.ts` explains why `allGeneratedPositionsFor` is required.
- **Source map "loaded" but mappings stale after HMR** → known gotcha; `ScriptStore.upsert` preserves the prior `consumer` on re-parse. Workaround: `close_session` + relaunch, or call `attachMap()` after a reload.
- **Chromium fails with `No usable sandbox!` or you are deciding on `--no-sandbox`** → [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) before changing launch defaults. To make local `npm run test:e2e` pass sandbox-on instead (install Playwright Chromium + attach the AppArmor profile) → [docs/local-l3-e2e-setup.md](./docs/local-l3-e2e-setup.md).
- **L4 eval cost spike or model-deprecation alert** → [docs/test-eval-plan.md](./docs/test-eval-plan.md) §L4 (cost gating + model rotation).
- **A test fails only on Windows / macOS / WSL2** → [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md) before anything else.
