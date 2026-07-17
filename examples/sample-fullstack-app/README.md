# examples/sample-fullstack-app/

**Last updated: 2026-07-17**

The human-facing full-stack demo app (LEO-464): a dev-build React frontend and an
Express backend that talk to each other, with one deliberate bug planted server-side.
One small app, four jobs:

1. The **interview demo** of simultaneous frontend + backend debugging — the scripted
   run lives in [DEMO.md](DEMO.md).
2. The base for the `fullstack-cart` L4 eval scenario (LEO-365).
3. The **dev-build React fixture** for the React DevTools work (`react-dev-tools-support`
   branch) — production React builds strip component names from the fiber tree, so that
   work needs exactly this app.
4. The subject of the README demo recording (LEO-453).

This is **not** a CI fixture. The dual-session L3 e2e spec uses its own minimal vanilla
fixture for determinism; nothing in `test/` or `evals/` builds this directory today.

## Stack and layout

| Path | What it is |
|---|---|
| `src/` | Vite + React 18.3.1 frontend (TypeScript). Components: `App` → `Header`/`CartBadge` + `ProductCard` → `CartButton`. Dev server only — there is deliberately no production build script. |
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

Knobs (all optional): `PORT` (API port; `PORT=0` picks a free port and prints it to
stdout as `sample-fullstack-app api listening on http://127.0.0.1:<port>`),
`VITE_API_URL` (where the frontend sends `/api/cart` calls; default
`http://127.0.0.1:3001`), `CORS_ORIGIN` (allowed browser origin; default
`http://localhost:5173`).

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
