# INDEX.md

**Last updated: 2026-06-05**

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

### docs/

| File | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Component diagram, layered view, request-flow sequences, session state machine, test-pyramid diagram. |
| [docs/chromium-sandboxing.md](./docs/chromium-sandboxing.md) | Canonical `--no-sandbox` / `sandbox: true` guidance: Chromium sandbox, AppArmor, unprivileged user namespaces, snap confinement, and Bubblewrap. |
| [docs/local-l3-e2e-setup.md](./docs/local-l3-e2e-setup.md) | Step-by-step runbook to get local `npm run test:e2e` passing sandbox-on on Ubuntu: install Playwright Chromium, verify the resolver, attach the `cdp-mcp-chromium` AppArmor `userns` profile, with the `CI=1` `--no-sandbox` fallback. |
| [docs/design-notes.md](./docs/design-notes.md) | Original design plan + a "What the implementation discovered" section (source-map line numbering, CRI typed-send trap, sessionId multi-target complexity). |
| [docs/launchd-service.md](./docs/launchd-service.md) | macOS launchd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/systemd-service.md](./docs/systemd-service.md) | Linux systemd user-service setup for running the npm package as a persistent local SSE server. |
| [docs/test-eval-plan.md](./docs/test-eval-plan.md) | The living test/eval spec — 4-layer pyramid, the fake-CDP contract layer (`test/fake-cdp.ts`), L4 cost model, **11 Critical Gotchas** every author has to know. |
| [docs/known-chromium-gaps.md](./docs/known-chromium-gaps.md) | Per-spec Chromium-vs-Chrome gaps (table grows as gaps surface) + host-OS workarounds (Windows 11 chrome-launcher ECONNREFUSED, WSL2 snap-Chromium). |

### Component READMEs

| File | What it covers |
|---|---|
| [src/session/README.md](./src/session/README.md) | `sessionState` singleton, browser lifecycle, `PauseTracker`, ring buffers. |
| [src/sourcemap/README.md](./src/sourcemap/README.md) | `ScriptStore`, lazy source-map loading, TS↔JS coordinate translation, path normalization. |
| [src/tools/README.md](./src/tools/README.md) | `registerJsonTool` pattern, structured error envelope, full 39-tool catalog. |
| [evals/README.md](./evals/README.md) | L4 LLM-agent eval harness, scenario shape, oracle/grader, cost + caching. |
| [examples/sample-app/README.md](./examples/sample-app/README.md) | Shared test fixture (Vite + TS), intentional bugs, how to run standalone. |

## Code map

Entry points:

| File | Role |
|---|---|
| [`src/index.ts`](./src/index.ts) | Stdio MCP server lifecycle (SIGINT/SIGTERM shutdown). What Claude Code launches. |
| [`src/server.ts`](./src/server.ts) | `buildServer()` — instantiates `McpServer`, calls each `registerXxxTools(server)`. |

Source tree:

| Directory | What's in it | README |
|---|---|---|
| `src/session/` | `sessionState` singleton, `launchChrome` / `attachChrome` / `closeSession` / `switchTarget`, `PauseTracker`, `RingBuffer<ConsoleEntry \| NetworkEntry>` | [README](./src/session/README.md) |
| `src/sourcemap/` | `ScriptStore` (compound key `sessionId+scriptId`), `attachScriptListener` / source-map loader (browser-first via `Network.loadNetworkResource`, Node `fetch` fallback), `mapCdpToOriginal` / `mapOriginalToGenerated`, `normalizeSourcePath` / `pathMatches` | [README](./src/sourcemap/README.md) |
| `src/tools/` | 39 MCP tools across 9 files: `session`, `nav`, `source`, `breakpoints`, `execution`, `inspect`, `console`, `network`, `dom`. Plus `_register.ts` (helper). | [README](./src/tools/README.md) |
| `src/util/` | `errors.ts` (`ToolError`, `noSession()`, `notPaused()`, `alreadySession()`), `format.ts` (`previewRemoteObject`, `truncate`, `describeRemote`, `toolJson`, `toolText`), `log.ts` (structured stderr logging). | — |
| `test/` | L2 contract tests (`test/tools/*.test.ts` against `test/fake-cdp.ts`), L3 e2e (`test/e2e/*.test.ts` against real headless Chromium). | [docs/test-eval-plan.md](./docs/test-eval-plan.md) |
| `evals/` | L4 harness — `evals/cli.ts` + `evals/harness/{vendor,anthropic,lm-studio-adapter,model,runner,grader,trace,mcp-client,static-server,types}.ts` (multi-vendor seam landed via #47) + scenarios (`evals/scenarios/*.ts`) + per-scenario variants (`evals/sample-app-variants/<name>/`). | [README](./evals/README.md) |
| `examples/sample-app/` | Vite + TS web app — the breakpoint-debug fixture. | [README](./examples/sample-app/README.md) |
| `scripts/` | `smoke.mjs`, `check-chromium-skips.mjs`, `build-variants.mjs`. | — |
