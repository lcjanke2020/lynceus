# examples/sample-app/

**Last updated: 2026-05-16**

The shared web-app fixture used by L3 e2e tests and L4 evals. A small Vite + TypeScript app with intentional bugs the agent is supposed to find.

## Stack

- Vite 5 + TypeScript 5 (no framework; vanilla DOM).
- Three source files:

| File | What it does |
|---|---|
| `src/main.ts` | Entry — wires the `#go` button to `handlers.ts`, posts to the worker. |
| `src/handlers.ts` | The bug surface. `computeStep()` is the canonical off-by-one. |
| `src/worker.ts` | A tiny Web Worker — used by scenarios that need a worker target. |

## The canonical bug — `compute-step`

`src/handlers.ts:12` returns `2` instead of `1` (inside `computeStep()`). The L4 `compute-step` scenario expects the agent to:

1. Open `localhost:5173` in a non-headless Chrome (or whatever port the variant's static server picked).
2. `set_breakpoint(file="src/handlers.ts", line=12)` — any of lines 6, 7, 8, 11, or 12 work (the scenario oracle accepts caller or callee; the agent can `step_into` / inspect the call stack from a `increment()` frame to reach `computeStep()`).
3. `click("#go")` to trigger the handler.
4. `wait_for_pause` → `get_scope` / `evaluate` / `get_call_stack` at the paused frame.
5. Conclude that `computeStep()` at `handlers.ts:12` returns `2` and that's why the displayed counter increments wrong.

The same flow is documented end-to-end in [README §End-to-end smoke (with a browser)](../../README.md).

## Other bugs (scenario variants)

Other scenarios use their own copies under `evals/sample-app-variants/<name>/`. Each variant is a tweak to this app:

| Variant | What's broken |
|---|---|
| `conditional-bp` | Exercises conditional-breakpoint resolution. |
| `console-error` | An uncaught error visible only via `get_console_logs`. |
| `deep-source-map` | Multi-layer source maps to stress bidirectional translation. |
| `event-binding` | A click handler wired to the wrong element. |
| `network-bug` | A fetch that fails silently. |
| `worker-bug` | A bug that only manifests in the Web Worker. |

Per the [root README](../../README.md), `compute-step` is the shipped scenario — the others land in the follow-up validation wave alongside L4 model-rotation work (PR #12).

## Running standalone

```sh
cd examples/sample-app
npm install
npm run dev          # listens on :5173 with HMR
npm run build        # tsc + vite build → dist/ used by L3 e2e tests
```

The L3 e2e harness builds this app via `npm run sample:build` at the repo root (the `pretest:e2e` hook runs it for you). You only need `npm run dev` for manual exploration.
