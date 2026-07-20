# sample-node-app

**Last updated: 2026-07-19**

Multi-entry tsc-compiled Node.js fixture for the Node-Inspector debugging work.
It is shared by the Node-Inspector e2e specs
(`test/e2e/node-*.e2e.test.ts`), the dual-session full-stack spec
(`test/e2e/fullstack-flow.e2e.test.ts`), and the Node eval scenarios
(`evals/scenarios/node-*.ts`).

Seven source files under `src/` share one `dist/` build — **six runnable
entries** (one per Node scenario, the original `index.ts`, and the full-stack
API fixture) plus the shared
helper `handlers.ts` (imported by `index.ts`, not a node entry itself).
No per-scenario variants tree: the browser side uses
`evals/sample-app-variants/` because its forks tweak the *static asset*
served to the browser; Node scenarios drive their own entry script
directly, so an entry-per-scenario in one shared package is sufficient.

The **Drives** column names the eval scenarios and e2e specs each entry
drives.

| File | Kind | Bug shape | Drives |
|---|---|---|---|
| `index.ts` | Entry | No bug — canonical two-file static-ESM-import shape with `handlers.ts`. Both scripts parsed before the `--inspect-brk` entry pause fires, so `set_breakpoint` on `handlers.ts` binds cleanly. | First L3 spec (`node-breakpoint-flow.e2e.test.ts`) + the README smoke + the README-documented `launch_node` / `attach_node` walkthroughs. |
| `handlers.ts` | Helper | — (no bug; imported by `index.ts`, not a runnable entry on its own). | Same as `index.ts` — provides the function `set_breakpoint` targets. |
| `compute-step.ts` | Entry | Off-by-one in `computeStep()` returning 2 (called via `main() → tick() → computeStep()`). Prints each tick via `process.stdout.write(...)` (raw stdio, not `console.log`). | `node-compute-step` L4 + `node-stepping.e2e.test.ts`. |
| `throw.ts` | Entry | Uncaught `TypeError` (null `.foo`) thrown inside `main() → processItem()`. | `node-uncaught-throw` L4 + `node-exceptions.e2e.test.ts`. |
| `stdio-bug.ts` | Entry | Bug observable only via OS-level stdout/stderr (not via V8's `Runtime.consoleAPICalled` — i.e. forces use of `get_node_output`). | `node-stdio-bug` L4 + `node-output.e2e.test.ts` + `node-console.e2e.test.ts`. |
| `conditional-bp.ts` | Entry | Iteration loop that only exhibits the bug on a specific iteration — set a conditional breakpoint or burn iterations. | `node-conditional-bp` L4 + `node-conditional-bp.e2e.test.ts`. |
| `fullstack-api.ts` | Entry | Port-0 built-in HTTP server; `GET /api/x` returns a small CORS-enabled JSON response and exposes a TS breakpoint in the request handler. | Browser+Node `fullstack-flow.e2e.test.ts` (LEO-116 acceptance). |

This fixture relies on the disk-backed-tsc-output contract (in-memory loaders
like `tsx`/`ts-node`/`bun` are out of scope for v1). The shape — seven source
files, six runnable entries plus the shared helper `handlers.ts` — keeps each
runnable entry isolating a single debugging scenario.

## Build

From the repo root:

```
npm run sample-node:build
```

That invokes `tsc -p examples/sample-node-app/tsconfig.json` using the
parent repo's `typescript` devDep — there is no nested `node_modules`.
Output lands in `examples/sample-node-app/dist/*.{js,js.map}` (gitignored
by the root `.gitignore`'s `dist/` rule).

`npm run pretest:e2e` runs this build automatically before the e2e suite, and
`preeval:quick:node` runs it before the `npm run eval:quick:node` smoke.

## Smoke

```
node --enable-source-maps examples/sample-node-app/dist/index.js
```

Prints `hello, world`. The four scenario entries (`compute-step`, `throw`,
`stdio-bug`, `conditional-bp`) intentionally misbehave — invoke them
through lynceus directly, or via the matching eval scenarios / e2e specs.
`fullstack-api` instead stays alive on an OS-selected port and prints its
listening URL for the L3 harness. `handlers.ts` is a helper imported by
`index.ts`, not a runnable entry.
