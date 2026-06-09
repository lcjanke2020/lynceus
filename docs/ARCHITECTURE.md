# Architecture

**Last updated: 2026-06-09**

How `cdp-mcp` is put together. For *why* decisions were made the way they were, see [design-notes.md](./design-notes.md) — especially its "What the implementation discovered" section. For test-pyramid depth + 11 critical gotchas, see [test-eval-plan.md](./test-eval-plan.md).

## At a glance

`cdp-mcp` is a stdio MCP server. An AI agent (Claude Code, Copilot CLI, …) launches it as a subprocess, sends MCP `tools/call` requests, and the server proxies them to a real Chrome/Chromium process through the Chrome DevTools Protocol (CDP). The server is **TS-aware**: coordinates the agent sends and receives are in TypeScript source (1-based lines, 0-based columns), translated to/from generated JS via the source maps Chrome already loads when it parses the bundle.

Three big pieces:

- A **tool layer** (`src/tools/`) — 48 thin handlers wrapping CDP calls with Zod schemas + a structured error envelope.
- A **state layer** (`src/session/` + `src/sourcemap/`) — owns the singleton Chrome process, the CDP client, the pause tracker, ring buffers, and the script store / source-map indexes.
- A **CDP transport** (`chrome-remote-interface`) — the WebSocket to Chrome, with flat sessions for the root page + every attached worker/iframe.

## Component diagram

```mermaid
flowchart LR
    Agent["AI agent<br/>Claude Code / Copilot CLI"]
    Index["src/index.ts<br/>stdio MCP lifecycle"]
    Server["src/server.ts<br/>registers 11 tool modules"]
    Tools["src/tools/<br/>48 tool handlers"]
    Session["src/session/<br/>state · pause · buffers"]
    Sourcemap["src/sourcemap/<br/>TS↔JS coords"]
    CRI["chrome-remote-interface<br/>(CDP client)"]
    Launcher["chrome-launcher<br/>(spawn binary)"]
    Chrome[("Chrome / Chromium")]
    Maps[(".map files<br/>disk or dev-server")]

    Agent -- "stdio JSON-RPC" --> Index
    Index --> Server
    Server --> Tools
    Tools --> Session
    Tools --> Sourcemap
    Session --> CRI
    Session --> Launcher
    Launcher --> Chrome
    CRI <-- "CDP WebSocket" --> Chrome
    Chrome -. "Debugger.scriptParsed" .-> Sourcemap
    Sourcemap -. "lazy fetch" .-> Maps
```

## Layered view

```mermaid
flowchart TB
    subgraph T["Tool layer — src/tools/"]
        TT["session · nav · source · breakpoints<br/>execution · inspect · console · network · dom<br/>forms · storage"]
    end
    subgraph S["State layer — src/session/ + src/sourcemap/"]
        SS["sessionState (singleton)<br/>PauseTracker · RingBuffer (console / network)<br/>ScriptStore (sessionId + scriptId)"]
    end
    subgraph C["CDP transport"]
        CC["chrome-remote-interface<br/>flat session: root + workers + iframes"]
    end
    subgraph B["Browser process"]
        BB["chrome-launcher → Chrome / Chromium"]
    end
    T --> S --> C --> B
```

## Module map

| Directory | Files | Responsibility | Component README |
|---|---|---|---|
| [`src/`](../src/) | `index.ts`, `server.ts`, `contract.ts`, `locator.ts` | Entry + server wiring + published `cdp-mcp/contract` (LocatorSpec) | — |
| [`src/session/`](../src/session/) | `state.ts`, `browser.ts`, `pause.ts`, `buffers.ts` | Singleton lifecycle, pause state, ring buffers | [README](../src/session/README.md) |
| [`src/sourcemap/`](../src/sourcemap/) | `store.ts`, `loader.ts`, `normalize.ts` | TS↔JS coordinate translation, script indexing | [README](../src/sourcemap/README.md) |
| [`src/tools/`](../src/tools/) | 11 tool files + `_register.ts` + `_locator_runtime.ts` | 48 MCP tool implementations | [README](../src/tools/README.md) |
| [`src/util/`](../src/util/) | `errors.ts`, `format.ts`, `log.ts` | `ToolError`, preview/truncate helpers, structured stderr logging | — |

## Request flow — `set_breakpoint`

The canonical TS-aware path. The agent thinks in TS coordinates; the server resolves the source map and binds in every script that maps back to that file (including workers and iframes).

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent
    participant T as set_breakpoint
    participant SS as ScriptStore
    participant SE as sessionState
    participant CRI as CRI client
    participant Ch as Chrome (CDP)

    A->>T: set_breakpoint(file="src/foo.ts", line=42)
    T->>SS: mapOriginalToGenerated(file, line, col=0)
    Note over SS: allGeneratedPositionsFor — not generatedPositionFor.<br/>esbuild/vite emit mappings at statement starts (col≥2), never col 0
    SS-->>T: [GeneratedLocation(scriptUrl, jsLine, jsCol, sessionId?)…]
    loop each candidate (page, worker, iframe)
        T->>CRI: Debugger.setBreakpointByUrl(url, line, col, sessionId)
        Note over T,CRI: url (not urlRegex) — regex is unanchored and would also<br/>match `?v=2`, `?vue&type=template`, …
        CRI->>Ch: CDP call
        Ch-->>CRI: { breakpointId, locations[] }
        CRI-->>T: response
        T->>SS: mapCdpToOriginal(loc)
    end
    T->>SE: breakpoints.set(id, record)
    T-->>A: { id, resolved_locations[], sessions_bound[] }
```

## Pause / step lifecycle

`PauseTracker` is the source of truth for "are we paused?" Tools that require a pause (`get_scope`, `get_call_stack`, `evaluate` with `frame_index`, the step tools) gate through `requirePaused()`. Step tools have a tricky interaction with CRI's synchronous event emission — see the entry-guard comment in `src/session/pause.ts` `waitForPauseOrResume()`.

```mermaid
sequenceDiagram
    autonumber
    participant Ch as Chrome
    participant CRI as CRI client
    participant PT as PauseTracker
    participant T as pause-only tool<br/>(step / scope / evaluate)
    participant A as Agent

    Note over Ch: User code hits a breakpoint
    Ch-->>CRI: Debugger.paused { callFrames, sessionId, hitBreakpoints }
    CRI->>PT: onPaused(state)
    A->>T: wait_for_pause / get_scope / step_over
    T->>PT: requirePaused()
    PT-->>T: SessionState (paused)
    alt step tool
        T->>PT: onResumed() — clear state before sending step
        T->>CRI: Debugger.stepOver(sessionId)
        CRI->>Ch: CDP method
        Note over Ch,PT: Chrome can deliver stepOver response<br/>and next Debugger.paused in the same WS batch
        Ch-->>CRI: Debugger.paused (next line)
        CRI->>PT: onPaused(state)
        T->>PT: waitForPauseOrResume(timeout)
        PT-->>T: state (or null on timeout = "resumed without pausing")
    end
    T-->>A: { paused, call_stack, reason }
```

## Session state machine

```mermaid
stateDiagram-v2
    [*] --> Disconnected
    Disconnected --> Launching: launch_chrome
    Disconnected --> Attaching: attach_chrome
    Launching --> Running: chrome-launcher + CRI connect ok
    Attaching --> Running: CRI connect ok
    Running --> Paused: Debugger.paused
    Paused --> Running: resume / step_over / step_into / step_out
    Running --> Closed: close_session
    Paused --> Closed: close_session
    Closed --> [*]: process exit
    Closed --> Disconnected: SessionState.reset()
```

`closeSession()` kills Chrome **only** when we `launch_chrome`'d it ourselves; an `attach_chrome` session leaves the user's Chrome running (`sessionState.attached === true`).

## Test pyramid

The full 4-layer strategy lives in [test-eval-plan.md](./test-eval-plan.md) — 338 lines and all worth reading. The shape:

```mermaid
flowchart BT
    L1["L1 — Unit<br/>src/**/*.test.ts<br/>pure data · ~ms · npm test"]
    L2["L2 — Contract<br/>test/tools/*.test.ts vs test/fake-cdp.ts<br/>48 tools · no real browser · npm test"]
    L3["L3 — E2E<br/>test/e2e/*.test.ts vs real headless Chromium<br/>seconds · npm run test:e2e"]
    L4["L4 — Agent evals<br/>evals/scenarios/* behind VendorAdapter seam<br/>(Anthropic, OpenAI, Vertex, DeepSeek, Moonshot + LM Studio reference)<br/>first observed: $3.97 full pass (Opus-4.7-medium, default) · npm run eval"]
    L1 --> L2 --> L3 --> L4
```

## External boundaries

What this code talks to:

- **CDP** (`chrome-remote-interface`) — WebSocket to Chrome. `Debugger.*`, `Page.*`, `Runtime.*`, `Network.*`, `DOM.*`, `Input.*`, `IO.*`, `Target.*`. Auto-attaches to workers + iframes via `Target.setAutoAttach({ flatten: true })`.
- **`chrome-launcher`** — spawns Chrome with `--remote-debugging-port`; cross-platform binary detection (`chrome_path` arg overrides).
- **File system** — TypeScript source files + source maps. Source maps are loaded **lazily** on `Debugger.scriptParsed` (`src/sourcemap/loader.ts` — browser-first via `Network.loadNetworkResource` to inherit auth/cookies/dev-server middleware, Node `fetch` fallback for plain localhost).
- **MCP stdio JSON-RPC** — talks to the agent (Claude Code, Copilot CLI). Stdout is reserved for the MCP protocol; logs go to stderr (see `src/util/log.ts`).
- **LLM SDKs (`@anthropic-ai/sdk`, `@google/genai`) + raw-fetch OpenAI-compatible clients** — used **only** by the L4 evals, behind the `VendorAdapter` seam (`evals/harness/vendor.ts` defines the interface). Adapters: `anthropic.ts`, `openai-adapter.ts` / `openai-responses-adapter.ts` / `openai-compat-adapter.ts`, `vertex-adapter.ts` (`@google/genai`), `deepseek-adapter.ts`, `moonshot-adapter.ts`, and the `lm-studio-adapter.ts` local reference. The production server has no LLM dependency.

## Where to go next

- Component depth → the 5 component READMEs (module-map table above).
- Design rationale + post-implementation gotchas → [design-notes.md](./design-notes.md).
- Test/eval depth + 11 critical gotchas → [test-eval-plan.md](./test-eval-plan.md).
- Chromium-vs-Chrome differences + host-OS workarounds → [known-chromium-gaps.md](./known-chromium-gaps.md).
- Current branch / PR / issue state → [../AGENTS.md](../AGENTS.md).
