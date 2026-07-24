# examples/sample-fullstack-app/

**Last updated: 2026-07-24**

The human-facing full-stack demo app (LEO-464): a dev-build React frontend and an
Express backend that talk to each other, with one deliberate bug planted server-side.
One small app, five jobs:

1. The **interview demo** of simultaneous frontend + backend debugging — the scripted
   run lives in [DEMO.md](DEMO.md).
2. The base for the `fullstack-cart` L4 eval scenario (LEO-365).
3. The **dev-build React fixture** for the React DevTools work (`react-dev-tools-support`
   branch) — production React builds strip component names from the fiber tree, so that
   work needs exactly this app.
4. The two React inspection L4 scenarios, `react-stale-closure` and
   `react-context-provider` (LEO-361).
5. The subject of the README demo recording (LEO-453).

This is not the L3 CI fixture: the deterministic dual-session e2e spec keeps its own
minimal vanilla page + Node entry. It **is** now the `fullstack-cart` L4 target. The
eval runner starts/stops this Vite dev server per trial, while the agent launches the
built backend under Node Inspector; `npm run sample-fullstack:build` installs the
lockfile-pinned dependencies, type-checks the frontend fixture, and emits
`server/dist/` with source maps.

## Stack and layout

| Path | What it is |
|---|---|
| `src/` | Vite + React 18.3.1 frontend (TypeScript). The normal route renders `App` → `Header`/`CartBadge` + `ProductCard` → `CartButton`; `?rdt_fixture=1` renders the deterministic RDT-2 read-tool fixture; `?rdt_scenario=stale-closure` and `?rdt_scenario=context-provider` render the RDT-3 L4 fixtures. Dev server only — there is deliberately no production build script. |
| `server/src/` | Express 5 backend (TypeScript, compiled by `tsc` with source maps — same disk-backed-tsc contract as `sample-node-app`). `index.ts` assembles the app; `cart.ts` owns the routes and the in-memory cart. |
| `DEMO.md` | The rehearsed dual-session interview demo script. |

## Quickstart

```sh
cd examples/sample-fullstack-app
npm install
npm run api    # builds server/ (tsc) and serves the API on http://127.0.0.1:3001
npm run dev    # in a second terminal: Vite dev server on http://localhost:5173
```

Open http://localhost:5173 — a three-product page with a cart counter in the header.
Click **Add to cart** and watch the counter stay at 0. That's the bug, and it's supposed
to be there.

Open `http://localhost:5173/?rdt_fixture=1` for the RDT-2 ground-truth page. It contains
a context provider, function and class consumers, a custom state/effect hook, and a
keyed row list. The React e2e asserts the exact initial seven-node tree, live props,
state/hooks/context, the mapped TypeScript definition site, and the eight-node tree
after **Add row** creates `row-3`. Keep this fixture deterministic and separate from the
normal demo route.

Open `http://localhost:5173/?rdt_scenario=stale-closure` for the source-solvable
control. `StaleCounter` advances once and then stays at 1 because its empty-dependency
effect closes over the initial `count`; React inspection supplies the live symptom and
source supplies the cause.

Open `http://localhost:5173/?rdt_scenario=context-provider` for the bridge-mandatory
case. `RuntimeThemeBoundary` places `SettingsWidget` under a nearer provider whose
value is created lazily per page: one non-light theme plus a high-entropy
`rdt-inner-*` provider ID. The ID is deliberately absent from rendered HTML and page
globals. Tests assert its shape and its identity round-trip rather than pinning a
particular random value.

Knobs (all optional): `PORT` (API port; `PORT=0` picks a free port and prints it to
stdout as `sample-fullstack-app api listening on http://127.0.0.1:<port>`),
`VITE_API_URL` (where the frontend sends `/api/cart` calls; default
`http://127.0.0.1:3001`), `CORS_ORIGIN` (allowed browser origin, replacing the default
allow-list of both loopback spellings — `http://localhost:5173` and
`http://127.0.0.1:5173` — so opening the page under either spelling just works).

From the repository root, the eval-oriented commands are:

```sh
npm run sample-fullstack:build
EVAL_BUDGET_USD=5 npm run eval:quick:fullstack
EVAL_BUDGET_USD=5 npm run eval:quick:react
```

The full-stack quick command is one paid trial with both correctness and mechanic currently
xfail-tagged. Its deterministic oracle requires concurrent browser/Node rows from
`list_sessions`, a bound breakpoint in each target's source coordinates, and a
Node-scoped pause in `server/src/cart.ts`; see [evals/README.md](../../evals/README.md).
Port 5173 must be unused before the runner starts Vite, and port 3001 must be free for
the agent-launched API.

The React quick command runs each React scenario once. Their oracles grade diagnosis
and React-tool adoption separately and require scenario-relevant values in successful
`inspect_react_component` results; a tool call alone earns no mechanic credit. Only
`react-stale-closure` carries a defensive mechanic xfail because its cause remains
readable from source.

## The bug — do not fix it

**Symptom:** add-to-cart never sticks. `POST /api/cart` responds `200` with
`{"items":[],"count":0}` no matter what you send, and `GET /api/cart` agrees.

**Root cause** (spoiler — the demo finds this live): in `server/src/index.ts`,
`app.use(express.json())` is registered **after** `app.use(cartRouter)`, so the JSON
body-parser never runs for the cart routes. Inside the `POST /api/cart` handler
(`server/src/cart.ts:24`) `req.body` is `undefined`, the defensive
`typeof body.id === "string"` guard quietly skips the add, and the handler returns the
untouched cart. Grepping the frontend can't find it; a breakpoint on the handler makes it
obvious — which is the point.

**The fix (one line, for verifying only — revert after):** move `app.use(express.json())`
above `app.use(cartRouter)` in `server/src/index.ts`, then `npm run api:build` and
restart. Verified: three POSTs (espresso ×2, grinder ×1) then return `"count":3`.

Line numbers in this directory are load-bearing: DEMO.md cites
`server/src/cart.ts:24` and `src/CartButton.tsx:15` as breakpoint targets. If you edit
those files, update DEMO.md.

## Why dev-build React matters

`npm run dev` serves React's development build (the `jsxDEV` transform +
`react_jsx-dev-runtime`), which keeps component names in the fiber tree. The React
DevTools bridge work depends on that, and the interview demo reads better when a paused
frame says `CartButton` instead of a minified single letter. Don't add a production
build path here.
