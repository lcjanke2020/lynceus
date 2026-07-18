# The dual-session cart-bug demo

**Last updated: 2026-07-17** · Target wall time: **≤ 10 minutes** (script budget ~8)

One lynceus server, two debug sessions — a browser and a Node backend — one agent
breakpointing both sides of the same `fetch`. The story: *"the cart shows 0 items after
add-to-cart, and the bug is on whichever side you can't grep from the other."*

> **Build requirement:** this script needs the `multi-session-support` demo cut
> (LEO-116 PRs 2–5: `session` params, `label`s, `list_sessions`). On master or the npm
> release, session-addressed calls don't exist yet — see **Fallback** at the bottom.

## One-time setup (before the interview, not during)

```sh
# 1. lynceus itself, from the multi-session-support branch
cd <repo> && npm install && npm run build

# 2. the demo app
cd examples/sample-fullstack-app && npm install && npm run api:build

# 3. wire the branch build into your MCP client, e.g.
claude mcp add lynceus -- node <repo>/dist/index.js

# 4. leave the frontend dev server running in a spare terminal
npm run dev        # http://localhost:5173
```

Sanity-check the symptom once in a plain browser **with the API up**: run `npm run api`
in a throwaway terminal, open http://localhost:5173, click **Add to cart**, watch the
header stay at `cart: 0`. Then **stop that API process** before the scripted run —
step 1's `launch_node` starts its own server on :3001 and needs the port free.
(Without the API running you'd see the *"backend unreachable"* banner instead of the
planted bug.)

## The script

Narration cues in *italics*. Expected results in the `→` lines. Path forms: the
`launch_node` `script` is **repo-relative** (it resolves against `cwd`);
`set_breakpoint` `file` values are **suffix-matched**, so the repo-relative and
app-relative spellings below both resolve — don't "normalize" one into the other.

**1. Launch the backend under the debugger.**

```
launch_node { script: "examples/sample-fullstack-app/server/dist/index.js",
              cwd: "<repo>", label: "backend" }
→ { session: "node_1", label: "backend", pid, port, ... }   # paused at entry
```

**2. Drain the entry pause, then breakpoint the cart handler — in TypeScript
coordinates.**

```
wait_for_pause { session: "node_1" }        # FIRST — see the note below
set_breakpoint { session: "node_1",
                 file: "examples/sample-fullstack-app/server/src/cart.ts", line: 24 }
→ { id: "bp_1", status: "set", ... }
resume         { session: "node_1" }        # release the entry pause
get_node_output{ session: "node_1" }
→ "sample-fullstack-app api listening on http://127.0.0.1:3001"
```

> ⚠️ `launch_node` returns as the process spawns; the **entry pause is what guarantees
> the scripts and their source maps are parsed**. Skip the `wait_for_pause` and the
> `set_breakpoint` can answer `no_mapping` — and the `resume`, `not_paused`.

*The breakpoint is set in `cart.ts` — the source map takes it to the compiled JS.*

**3. Launch the browser session next to it.**

```
launch_chrome  { url: "http://localhost:5173", label: "frontend" }
→ { session: "browser_1", label: "frontend", targetId, url }
list_sessions  {}
→ { sessions: [ { session: "node_1",    kind: "node",    label: "backend",  ... },
                { session: "browser_1", kind: "browser", label: "frontend", ... } ] }
```

*Two live sessions, one server, one agent. This is the founding-goal slide.*

**4. Breakpoint the click handler, then click — click and wait issued together.**

```
set_breakpoint { session: "browser_1", file: "src/CartButton.tsx", line: 15 }
→ { id: "bp_1", status: "set", ... }        # ids are per-session; step 8 removes this one

# issue the next two as PARALLEL calls in one agent turn:
click          { session: "browser_1", selector: "#add-espresso" }
wait_for_pause { session: "browser_1" }
→ paused at CartButton.tsx:15, frame `handleAddToCart`
get_scope      { session: "browser_1", frame_index: 0 }
→ `product` = { id: "espresso", name: "Espresso Machine", ... }
```

> ⚠️ The `click` call **doesn't settle while the breakpoint holds the page** — it
> resolves only after the session resumes. Ask the agent to issue `click` and
> `wait_for_pause` together (parallel tool calls), or click by hand in the Chrome
> window and only call `wait_for_pause`. Awaiting the click alone deadlocks the demo.

*Paused in a dev-build React component, TSX coordinates, before the request exists.*

**5. Release the browser; catch the same request on the other side.**

```
resume         { session: "browser_1" }     # the fetch departs; the pending click settles
wait_for_pause { session: "node_1" }
→ paused at cart.ts:24, the POST /api/cart handler
```

> ⚠️ Don't `step_over` the `await` on the browser side while the backend breakpoint is
> armed: the step only completes when the response returns, and the response is about to
> be paused on the Node side. Resume the browser, then wait on `node_1`.

**6. The reveal.**

```
get_scope { session: "node_1", frame_index: 0 }
→ locals: `req`, `res`; `body` not yet assigned
evaluate  { session: "node_1", frame_index: 0, expression: "req.body" }
→ undefined
evaluate  { session: "node_1", frame_index: 0,
            expression: "req.headers['content-type']" }
→ "application/json"
```

*JSON arrived; parsed body is `undefined` — the body-parser never ran for this route.
Open `server/src/index.ts`: `app.use(express.json())` is registered __after__
`app.use(cartRouter)`. Middleware ordering. The guard in the handler swallows it
silently.*

**7. (Optional flourish) Prove the diagnosis without touching the source.**

```
evaluate { session: "node_1", frame_index: 0,
           expression: "req.body = { id: 'espresso', name: 'Espresso Machine' }" }
resume   { session: "node_1" }
→ header ticks to cart: 1 — the patched request went through
```

Skip this step if it misbehaved in rehearsal; it's a bonus, not the spine.

**8. Fix, rebuild, re-run.**

```sh
# in server/src/index.ts: move `app.use(express.json())` above `app.use(cartRouter)`
npm run api:build
```

```
close_session  { session: "node_1" }
launch_node    { script: "examples/sample-fullstack-app/server/dist/index.js",
                 cwd: "<repo>", label: "backend" }
→ { session: "node_2", label: "backend", ... }    # fresh id — ids are never recycled
wait_for_pause { session: "node_2" }              # same entry-pause drain as step 2
resume         { session: "node_2" }              # no server breakpoint needed this time
remove_breakpoint { session: "browser_1", id: "bp_1" }   # the step-4 breakpoint — else
click          { session: "browser_1", selector: "#add-espresso" }  # this click pauses again
→ header shows cart: 1 (fresh server state)
```

*Prefer the theater?* Leave the breakpoint armed, issue `click` + `wait_for_pause`
together again (step-4 rules), and narrate *"same breakpoint fires — but this time the
request goes through"* before resuming. Costs ~30s; rehearse whichever you'll perform.

**9. Close the loop end-to-end (if time remains).**

```
get_network_requests { session: "browser_1", url_match: "/api/cart" }
get_response_body    { session: "browser_1", request_id: <from above>, session_id: null }
→ {"items":[{"id":"espresso",...,"qty":1}],"count":1}
```

*Same agent saw the click, the paused handler, and the response body — full-stack,
one tool surface.* Note `session` (`browser_1`) and `session_id` (CDP child target)
side by side here — different axes, deliberately different names.

## Timing budget

| Steps | Budget |
|---|---|
| 1–3 launch + breakpoints | 2 min |
| 4–5 click → both pauses | 2 min |
| 6 the reveal | 2 min |
| 7–8 fix + re-run | 2 min |
| 9 + narration slack | 2 min |

## Fallback (back pocket, works on master today)

If the branch build misbehaves on the day: register **two** stdio lynceus instances in
the MCP client (`lynceus-fe`, `lynceus-be`), one per target — no session params, same
story, slightly clunkier narration. Zero code required.

## Rehearsal log

DEMO.md counts as rehearsed when a timed end-to-end run against the demo-cut branch
build lands here (LEO-464 acceptance).

| Date | Branch head | Wall time | Result | Notes |
|---|---|---|---|---|
| — | — | — | — | not yet rehearsed |
