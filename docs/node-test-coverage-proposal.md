# Node.js Test Coverage Expansion — Proposal

**Status:** ✅ **Implemented.** This proposal is preserved for the design rationale and the cost/sequencing plan. Implementation landed in the phases described below:

- **Phases A + B** — fixture extensions (4 new entries under `examples/sample-node-app/src/`) + 5 L3 e2e specs.
- **Phase A.5** — harness Node-target seam (`Scenario.target` discriminator + runner branch + `cli.ts` / `RunTrialOpts` / `ScenarioStartEntry` contract extensions).
- **L4 scenarios** — `node-compute-step` (+ `eval:quick:node`), `node-stdio-bug` (mandates `get_node_output`), `node-conditional-bp`, and `node-uncaught-throw` (exception flow + re-launch recovery).

Lessons captured during implementation, worth folding into the canonical docs over time:

- Node ESM module-level throws don't classify as `uncaught` — V8 sees Node's loader's internal try/catch. L3 exception tests use `state:"all"`.
- Conditional-bp tests must place the breakpoint on a line that runs every iteration — otherwise the test passes even if the condition is ignored.
- For re-launch recovery scenarios (exceptions), oracles must iterate ALL pause indices, not `findIndex` — re-paused windows are otherwise missed.

---

## Original proposal (preserved)

This doc proposes adding L3 e2e tests and L4 eval scenarios for the Node.js Inspector support that landed via the Node epic. L2 contract coverage was already at parity; the gap was at the integration (L3) and agent-driven (L4) tiers.

---

## Recommendation

**Add 5 new L3 e2e tests + 4 new L4 eval scenarios + one new harness Node-target seam + one new fixture-multi-entry pattern.** Land in this order to keep paid-API cost contained:

1. **One PR for Phases A + B** (zero API cost) — fixture extensions + 5 L3 tests.
2. **One PR for Phase A.5** (zero API cost) — harness Node-target seam (the runner is browser-specific today).
3. **One PR each for the four L4 scenarios** (each validates with a single-trial Anthropic Opus-medium paid smoke at ~$0.35 before merge).
4. **Optional post-merge:** full Node baseline run across all three production vendors (~$5–8).

**Total paid validation cost during the work itself: ~$1.40** (4 single-vendor smokes). Tri-vendor baseline is a separate post-merge step.

This is **not** full browser-side parity. It is the load-bearing subset — canonical breakpoint/pause/inspect cycle, exception flow, and the `get_node_output` tool that started with zero L4 coverage. Worker threads, cluster, lazy CJS, and pending-breakpoint-in-not-yet-loaded-modules remain deferred per [docs/node-session-design.md](./node-session-design.md) §9.

---

## Context

The Node.js Inspector epic landed the session-mode split (`SessionState.kind`), `attach_node` / `launch_node`, the kind-aware source-map loader (`file://` for Node), capability gating for browser-only tools in Node sessions, the `get_node_output` buffered-stdio tool, and an initial L3 fixture + breakpoint-flow spec.

### Coverage parity at the time of proposal

| Level | Browser | Node | Gap |
|---|---:|---:|---|
| L2 contract | shared + browser-only across categories + capability gates | Node-specific (`test/tools/node-session.test.ts` + `test/tools/node-output.test.ts`) | **At parity** |
| L3 e2e | ~19 tests across 9 files | 2 tests across 2 files | **Large gap** |
| L4 eval | 8 scenarios registered | **0 scenarios** | **Largest gap** |

(L2 test counts are nominal — current as of writing but may drift.)

The new Node code was well-validated against the fake CDP (L2) but under-validated against real Node + a real agent (L3, L4). This proposal closes the integration- and agent-tier gap on a useful subset of flows.

---

## Scope decisions

1. **Shared fixture, multi-entry.** Extend [`examples/sample-node-app/`](../examples/sample-node-app/) with several entry scripts (`compute-step.ts`, `throw.ts`, `stdio-bug.ts`). All Node scenarios share one `dist/` build. No `evals/sample-node-app-variants/` tree. Rationale: the browser side uses separate variant builds because its forked variants tweak the *static asset* served to the browser; Node scenarios drive their own entry scripts directly, so an entry-per-scenario in one shared package is sufficient.
2. **4 L4 scenarios.** `node-compute-step`, `node-stdio-bug`, `node-conditional-bp`, `node-uncaught-throw`. Mirrors the most load-bearing browser flows + closes the `get_node_output` L4 coverage hole + covers the conditional-bp efficiency primitive.
3. **`eval:quick` unchanged.** Stays at browser `compute-step` (~$0.33). Add a new `eval:quick:node` script for the Node smoke (opt-in, same cost shape). The per-PR gate cost is unchanged.
4. **Out of scope** (deferred per [docs/node-session-design.md](./node-session-design.md) §9 + [README.md](../README.md) "Out of scope"):
   - Worker threads (`worker_threads` module)
   - `cluster` module / multi-process Node
   - Lazy CJS `require` / dynamic `import()` pending-breakpoint binding
   - Pending breakpoints in not-yet-loaded modules (entry-pause races are mitigated; a full fix is its own follow-up)

---

## Phase A — Extend `examples/sample-node-app/` fixture

Add four new ESM entry scripts under [`examples/sample-node-app/src/`](../examples/sample-node-app/src/). All compile under the existing tsc pipeline; one shared `dist/` after build.

| Entry | Bug shape | Frame depth | Drives scenario |
|---|---|---:|---|
| `compute-step.ts` | Off-by-one in `computeStep()` returning 2; called by `main() → tick() → computeStep()`. Prints each tick's result via **`process.stdout.write(...)`** (raw stdio, not `console.log`) so the agent can observe the wrong sequence via `get_node_output`. | 3 | `node-compute-step` |
| `throw.ts` | Uncaught `TypeError` (null `.foo` access) thrown inside `main() → processItem()` | 2 | `node-uncaught-throw` |
| `stdio-bug.ts` | Off-by-one in accumulator; prints the resulting wrong total via **`process.stdout.write(...)`** (NOT `console.log` — see Phase C #3 rationale). No exception, no thrown bug. | 2 | `node-stdio-bug` |
| `conditional-bp.ts` | Loops over `0..N-1` calling `process(i)`; `process` has a bug that only manifests for one specific `i` (e.g. wrong branch taken when `i === 3`). Encourages a conditional breakpoint rather than a 5-times-resume pattern. | 2 | `node-conditional-bp` |

Existing `src/index.ts` + `src/handlers.ts` stay (drives current L3 Node tests). No changes to the existing fixture files.

---

## Phase B — L3 e2e tests for Node

Five new files under [`test/e2e/`](../test/e2e/). Follow [`node-breakpoint-flow.e2e.test.ts`](../test/e2e/node-breakpoint-flow.e2e.test.ts) / [`node-launch-flow.e2e.test.ts`](../test/e2e/node-launch-flow.e2e.test.ts) shape (vitest + the shared `close_session` afterEach).

| New file | What it verifies | Tools exercised |
|---|---|---|
| `node-stepping.e2e.test.ts` | Step through multi-frame chain in `compute-step.ts`: entry-pause → bp on `tick()` → `step_into` → `step_over` → `step_out`; assert TS-mapped frames at each step | `set_breakpoint`, `wait_for_pause`, `step_over`, `step_into`, `step_out`, `get_call_stack` |
| `node-exceptions.e2e.test.ts` | `set_pause_on_exceptions={mode:"uncaught"}` against `throw.ts`; assert pause reason = `"exception"` with TS-mapped frame. **Required ordering:** call `set_pause_on_exceptions` *while still at the `--inspect-brk` entry pause*, then `resume` — otherwise the script throws and the process exits before the agent can re-pause (entry-pause-vs-throw race; no browser analogue). | `set_pause_on_exceptions`, `wait_for_pause`, `get_call_stack`, `get_scope` |
| `node-console.e2e.test.ts` | Node V8 `console.log` captured via `Runtime.consoleAPICalled` into the **same** `get_console_logs` buffer used by the browser side. Confirms the kind-agnostic console path. | `get_console_logs` on a Node session |
| `node-output.e2e.test.ts` | `launch_node` runs `stdio-bug.ts` (which uses `process.stdout.write`) → `get_node_output` returns the printed lines, paginated via `since` cursor; survives process exit. Asserts the **same** lines do NOT appear in `get_console_logs` (channel separation; see [`src/tools/node-output.ts`](../src/tools/node-output.ts)). | `launch_node`, `get_node_output`, `get_console_logs` (negative-assertion), `close_session` (SIGTERM→SIGKILL path) |
| `node-conditional-bp.e2e.test.ts` | Conditional breakpoint with `condition: "i === 3"` inside the `conditional-bp.ts` loop; assert pause fires only on the matching iteration. Shares the fixture entry with the L4 `node-conditional-bp` scenario. | `set_breakpoint` (with condition), `wait_for_pause`, `evaluate` |

Existing L3 Node tests are left untouched.

---

## Phase A.5 — Harness Node-target seam

The original draft claimed "Harness changes — none". That was wrong. The runner is browser-specific today: [`evals/harness/runner.ts`](../evals/harness/runner.ts) calls `startStaticServer(variantDistDir)`, frames the first user message as `Page under test: ${variantUrl}`, the default system prompt prescribes `launch_chrome` / `navigate` / `click`, and Chrome-binary resolution always runs. A Node eval agent needs the built JS entrypoint for `launch_node`, not a URL, and should not be told the primary target is a web page.

This phase lands between A+B and the first L4 scenario PR so the L4 scenario PRs stay scoped to oracle + fixture work.

### Contract change

This phase touches **four** files, not just `runner.ts` (`Scenario.variantDir`-required + the `cli.ts` `existsSync` precondition would otherwise make the seam un-implementable):

**1. [`evals/harness/types.ts`](../evals/harness/types.ts)** — extend `Scenario` with a `target` discriminated union. Either approach works; both are kind-safe:

```ts
// Approach A — additive: target optional, variantDir stays for browser scenarios.
interface Scenario {
  name: string;
  prompt: string;
  oracle: (trace: TraceEntry[], finalAnswer: string) => OracleResult;
  oracleMinimumToolCalls: number;
  target?: ScenarioTarget;        // NEW; defaults to { kind: "browser", variantDistDir: variantDir }
  variantDir?: string;            // REQUIRED for browser scenarios; ignored when target.kind === "node"
  // … other existing fields
}

type ScenarioTarget =
  | { kind: "browser"; variantDistDir: string }
  | { kind: "node"; script: string };  // path to built .js entrypoint
```

```ts
// Approach B — cleaner: a real browser/node union on Scenario itself.
type Scenario = BrowserScenario | NodeScenario;
interface BrowserScenario extends ScenarioBase { kind: "browser"; variantDir: string; }
interface NodeScenario extends ScenarioBase { kind: "node"; script: string; }
```

Approach B is preferred because it makes "browser scenario without `variantDir`" a type error rather than a runtime fail. The implementation can pick either; the proposal is agnostic, but recommends B. (Trade-off: B touches all existing browser scenarios; A is purely additive — only Node scenarios change.)

**2. [`evals/cli.ts`](../evals/cli.ts)** — the existence check (`existsSync(scenario.variantDir)`) fails for Node scenarios that omit `variantDir`. Branch on `target.kind` (or scenario kind under Approach B): for browser, `existsSync(scenario.variantDir)`; for node, `existsSync(scenario.target.script)` (or `scenario.script`). Same pattern for whatever else cli.ts reads off the scenario before handing to `runTrial()`.

**3. `RunTrialOpts`** (in `evals/harness/runner.ts` or `types.ts`, wherever it currently lives) — `variantDistDir` becomes either:
- A discriminated union mirroring `Scenario.target`, or
- Two optional fields (`variantDistDir?: string` + `nodeScript?: string`) with a runtime invariant that exactly one is set.

The union is preferred — same reason as Approach B above.

**4. `ScenarioStartEntry` trace contract** (in `evals/harness/trace.ts` / `types.ts`) — currently has a required `variantUrl` field. For Node trials this is meaningless. Two options:
- Add a `target: ScenarioTarget` field to `ScenarioStartEntry`, with `variantUrl` becoming optional (present only when `target.kind === "browser"`).
- Make `variantUrl` accept the script path string for Node trials (e.g. prefixed `file://` URL) and document the dual interpretation.

Option A is cleaner and gives downstream trace consumers (rotation analytics, cross-vendor variance characterization) an unambiguous provenance signal. The trace-shape change is small but real — an earlier draft's claim that "trace shape … is unchanged" was wrong; corrected here.

### Runner changes

In [`evals/harness/runner.ts`](../evals/harness/runner.ts):

1. Branch on `target.kind` before the static-server / Chrome-binary path. For `node`, skip `startStaticServer` + Chrome resolution entirely; assert the `script` path exists at startup (redundant with the cli.ts check, but worth double-guarding — a Node entry that vanishes between cli.ts and runner.ts startup is a real concurrent-build hazard).
2. System prompt branch: introduce a `NODE_SYSTEM_PROMPT` sibling to the current browser one. Prescribes `launch_node` / `set_breakpoint` / `get_node_output` / `get_console_logs` / `wait_for_pause` / inspection tools. Capability gating already returns `error: "unsupported_target"` for browser-only tools on Node sessions — the prompt should **explicitly list the blocked surface** (the `BROWSER_ONLY` set in `src/session/capabilities.ts`: `navigate`, `reload`, `get_url`, `query_selector`, `get_element_html`, `locate`, `wait_for`, `get_form_state`, `click`, `type_text`, `press_key`, `screenshot`, `get_network_requests`, `get_request_body`, `get_response_body`, plus `select_target`, and the storage tools) so the agent doesn't waste first-turn planning on probes that will return `unsupported_target`. Either paste the Node-blocked set into the prompt at build time (preferred — single source of truth) or hand-curate the list with a comment pointing back to `TOOL_KIND_SUPPORT`.
3. First user message branch: for Node, frame as `Node script under test: ${target.script}` instead of `Page under test: ${url}`. Include the script path verbatim so the agent can pass it straight to `launch_node({ script })`.
4. **Trace shape:** small change — `ScenarioStartEntry` gains a `target` field (see contract change #4 above). Vendor adapters, pricing catalog, MCP-client glue, and grader are unchanged. Kind-agnostic.

### L2 / L3 tests for this phase

- Unit-test the discriminator: a `kind: "node"` scenario through the runner does NOT start a static server, does NOT resolve a Chrome binary, and uses the Node system prompt + Node user-message framing. Mock-driven; no real Node spawn.
- One small L3 test that runs the runner end-to-end with a dummy Node scenario (no oracle scoring, just verifies the runner glues correctly into a real `dist/index.js` MCP subprocess + a real `launch_node` flow). Can share `examples/sample-node-app/dist/compute-step.js` with the eventual `node-compute-step` scenario.

### Why a contract change rather than `systemPromptOverride` + prompt convention

One alternative was `systemPromptOverride` + a prompt convention that includes the script path. The contract change is preferred:

- The prompt convention makes the script path's existence invisible to the runner — if the path is stale or missing, the failure mode is "agent calls `launch_node` with a bad path and waits for a child that won't start." The contract gives the runner a startup-time check.
- The static-server + Chrome-binary skip is conditional on `target.kind`, not on a system-prompt string. A prompt convention can't drive that branching cleanly.
- The trace gains an unambiguous "this trial targeted a Node script at `<path>`" provenance signal, which is useful for post-hoc analysis.

---

## Phase C — L4 Node eval scenarios

Four new scenarios under [`evals/scenarios/`](../evals/scenarios/). Each follows the [`compute-step.ts`](../evals/scenarios/compute-step.ts) template: pure-function `oracle()` returning `{ correctness, mechanic, efficiency, recovery, notes }` (see [`evals/harness/types.ts`](../evals/harness/types.ts)), `oracleMinimumToolCalls` set by hand-tracing the minimal happy path. **Each sets `target: { kind: "node", script: "examples/sample-node-app/dist/<entry>.js" }`** per Phase A.5; `variantDir` is omitted.

Reuse `toolPairs()` from [`evals/harness/trace.ts`](../evals/harness/trace.ts) to inspect the trace. Reuse the oracle-unit-test helpers from [`evals/scenarios/_test-helpers.ts`](../evals/scenarios/_test-helpers.ts) for the L1 oracle tests.

**All four scenarios are `launch_node`-only**, not `attach_node`. The harness only supplies a script path via `target.script` (per Phase A.5); it doesn't pre-launch a Node process and advertise a host/port. An agent calling `attach_node` would try the default inspector port and fail unless some unrelated process happened to be listening — so the oracles require `launch_node` rather than accepting either entry point. If a future `attach_node` scenario shape is needed, Phase A.5's `target` discriminator can be extended with an `{ kind: "node-attach"; host: string; port: number }` variant whose runner branch pre-launches the inspectee process.

### Scenarios

1. **`node-compute-step`** — canonical Node port of `compute-step`
   - **Prompt sketch:** "A Node script ticks a counter and prints each tick to stdout — each tick should add 1 but adds 2. Diagnose the bug as file:line."
   - **Mechanic (required for mechanic=1):** `launch_node` + `set_breakpoint` on `compute-step.ts` + `wait_for_pause` whose result has **`hit_breakpoint_ids` non-empty AND containing the id returned by an earlier `set_breakpoint` call** (i.e. a real bp hit, not the `--inspect-brk` entry pause) + at least one inspection call (`get_call_stack` | `get_scope` | `evaluate`). **Critical:** do NOT gate on `reason="other"` — per [`docs/node-session-design.md`](./node-session-design.md) and the file-level comment in [`test/e2e/node-breakpoint-flow.e2e.test.ts`](../test/e2e/node-breakpoint-flow.e2e.test.ts), V8 emits non-standard pause-reason strings on Node (e.g. `"Break on start"` for entry pause), so reason-equality assertions are unsafe. The canonical breakpoint-hit check is `hit_breakpoint_ids` membership (same assertion the L3 test uses: `expect(bpHit.hit_breakpoint_ids).toContain(bp.id)`).
   - **`get_node_output` is optional / diagnostic — does NOT affect mechanic.** The agent may call `get_node_output` to observe the wrong tick sequence as a discovery aid (it's the natural Node idiom and the fixture prints via `process.stdout.write` to support that), but the mechanic credit comes from the bp+pause+inspect cycle. This avoids two failure modes: (a) the gameable path where the agent earns mechanic via `launch_node` → `get_node_output` → `evaluate` (on entry pause) → final without ever binding a breakpoint, and (b) correlating `get_node_output` signal across scenarios — `node-stdio-bug` (#3) remains the only scenario where `get_node_output` is mandatory.
   - **Correctness:** final answer names `compute-step.ts` + the line of the off-by-one or `computeStep` symbol.
   - **Minimum tool calls:** **6**, hand-traced from the canonical happy path:
     1. `launch_node({ script })` — process starts paused at entry (`--inspect-brk`)
     2. `set_breakpoint({ file: "src/compute-step.ts", line: N })` — works while paused at entry; returns `{ id }`
     3. `resume` — releases from entry; script runs until bp hit and auto-pauses
     4. `wait_for_pause` — returns `{ hit_breakpoint_ids: [<id from #2>], … }` (this is the assertion that gates mechanic)
     5. `get_call_stack` (or `get_scope` / `evaluate` on the paused frame)
     6. `resume` — terminal resume to let the process exit cleanly

     The final natural-language answer to the harness is **not** a tool call and does not count toward `oracleMinimumToolCalls`. Confirm `oracleMinimumToolCalls = 6` by re-running the hand trace against the actual harness during implementation; adjust if the harness adds an implicit call.
   - **Implementer note:** the simplest implementation reuses the browser `compute-step` oracle's *structure* but NOT its assertions verbatim — browser `compute-step` uses a permissive `"reason" in output` check that works because browsers don't have an entry-pause analog. Node oracles need the `hit_breakpoint_ids`-membership check. The L3 `test/e2e/node-breakpoint-flow.e2e.test.ts` already exercises that pattern and is the right reference. `get_node_output` shows up in the trace as a no-op for scoring (worth a one-line comment in the scenario file noting this is deliberate).

2. **`node-uncaught-throw`** — exception flow
   - **Prompt sketch:** "A Node script throws an uncaught exception. Diagnose where and why. Report file:line and the root cause."
   - **Mechanic:** trace contains a `set_pause_on_exceptions` call AND a `wait_for_pause` that returned reason=`"exception"` AND at least one inspection call (`get_call_stack` | `get_scope`). **Oracle does NOT lock a specific tool ordering:** an agent who resumes the entry pause too early, observes the process exit, and retries via re-launch (setting pause-on-exceptions before resume the second time) still earns mechanic=1. The browser side doesn't have this failure mode because the DOM doesn't auto-exit on uncaught; on Node it's the normal recovery path, so penalizing it would conflate ordering with workflow fluency.
   - **Correctness:** final answer names `throw.ts` + the offending line + the null-deref nature of the bug.
   - **Minimum tool calls:** ~6 (launch + pause-on-exceptions + resume + wait + inspect + final). If the agent needs a re-launch round, mechanic still passes and `recovery` increments.
   - **Implementation note:** `examples/sample-node-app/src/throw.ts` should throw quickly after `--inspect-brk` releases, so the resume-too-soon failure is reproducible at oracle-design time. Hand-trace at least one resume-too-soon run when calibrating `oracleMinimumToolCalls`.

3. **`node-stdio-bug`** — exercises `get_node_output` at L4 (this tool started with zero L4 coverage)
   - **Prompt sketch:** "A Node script prints a computed total to stdout. The printed value is wrong — discover what was printed and diagnose the bug as file:line and the offending computation." *(The prompt deliberately does NOT state the printed value. If it did, an agent could pause on the breakpoint, read the accumulator from scope, and skip both `get_console_logs` and `get_node_output` entirely.)*
   - **Fixture constraint:** `stdio-bug.ts` MUST print via `process.stdout.write(...)`, not `console.log(...)`. The tool split in [`src/tools/node-output.ts`](../src/tools/node-output.ts) routes `console.log` to `get_console_logs` (V8 `Runtime.consoleAPICalled`) and raw stdio to `get_node_output` — using `console.log` would dilute the `get_node_output` signal because the agent could discover the wrong value via the shared console buffer.
   - **Mechanic:** trace contains `launch_node` + `get_node_output` (must pull stdout to see the printed value) + `set_breakpoint` + `wait_for_pause` + inspect.
   - **Mechanic explicitly rejects:** a trace that exercises `get_console_logs` instead of `get_node_output` is scored mechanic=0 even if the breakpoint + pause + inspect cycle succeeded. The oracle should assert `get_node_output` appears in the trace before mechanic=1.
   - **Correctness:** final answer names `stdio-bug.ts` + the accumulator line.
   - **Minimum tool calls:** ~8 (launch + get_node_output + breakpoint + wait + inspect + final).
   - **Why this matters:** this is the **only** scenario where `get_node_output` is required for mechanic=1 (uniqueness signal). `node-compute-step` *may* exercise `get_node_output` as a natural-Node-idiom probe but doesn't require it (see scenario #1 above). So per-scenario mechanic distinguishes "agent reaches for `get_node_output` when natural" (#1 either way) from "agent reaches for it when mandatory" (#3 only). Without the prompt-leak fix + raw-stdio fixture + console-rejecting oracle, the mandatory signal is gameable.

4. **`node-conditional-bp`** — conditional breakpoint flow on Node
   - **Prompt sketch:** "A Node script loops over a range calling `process(i)` and produces wrong output for one specific value of `i`. Diagnose which `i` triggers the bug and what `process` does wrong — report file:line. Avoid 5×resume; use the debugger's condition support."
   - **Mechanic:** `launch_node` + `set_breakpoint` **with a non-empty `condition` field** (e.g. `i === 3`) + `wait_for_pause` (must fire on the matching iteration, not a different one) + inspect.
   - **Mechanic explicitly rejects:** a trace that uses an unconditional breakpoint and pauses on every iteration scores mechanic=0 even if correctness is right. The oracle should assert at least one `set_breakpoint` call had `condition` truthy. The L3 test confirms the condition works; the L4 scenario tests whether the agent *chooses* it.
   - **Correctness:** final answer names `conditional-bp.ts` + the offending line + identifies which `i` value triggers the bug.
   - **Minimum tool calls:** ~7 (launch + conditional-breakpoint + wait + inspect + resume + final).
   - **Why this matters:** conditional breakpoints are a core efficiency primitive — a 1000-iteration loop without conditions is infeasible. The browser side has `conditional-bp` for the same reason ([evals/scenarios/conditional-bp.ts](../evals/scenarios/conditional-bp.ts)); skipping it on the Node side would leave the most important efficiency-leverage tool unexercised at L4.

### Registry + L1 oracle tests

- Register the four scenarios in [`evals/scenarios/index.ts`](../evals/scenarios/index.ts) alongside the existing 8 browser scenarios.
- Add `evals/scenarios/node-compute-step.test.ts`, `node-uncaught-throw.test.ts`, `node-stdio-bug.test.ts`, `node-conditional-bp.test.ts` — pure L1 oracle unit tests (no LLM, no Node spawn).

### Harness changes — see Phase A.5

The vendor adapters, pricing catalog, MCP-client glue, trace shape, and grader are all kind-agnostic — no changes there. But the runner *does* need a Node-target branch (static-server skip, Chrome-binary-resolve skip, Node system prompt, Node first-user-message framing). That lands in [Phase A.5](#phase-a5--harness-node-target-seam) as its own PR before the L4 scenario PRs.

---

## Phase D — `eval:quick:node` script + Node prebuild

Add two scripts to `package.json` alongside `eval:quick`:

```json
"preeval:quick:node": "npm run build && npm run sample-node:build",
"eval:quick:node": "tsx evals/cli.ts --scenarios=node-compute-step --trials=1"
```

The `preeval:quick:node` hook is required: npm's lifecycle prefix resolution looks for `preeval:quick:node` (not `preeval` or `preeval:quick`) when running `eval:quick:node`. Without it, the Node entrypoints in `examples/sample-node-app/dist/*.js` can be stale or absent, and the trial would fail-fast on the Phase A.5 startup-time path-exists check.

**Existing `sample-node:build` script** (`package.json`): `tsc -p examples/sample-node-app/tsconfig.json`. The new entries from Phase A inherit; no tsconfig changes needed.

For full `npm run eval -- --scenarios=node-*` paid runs, prebuild manually:

```bash
npm run build && npm run sample-node:build && \
  npm run eval -- --scenarios=node-compute-step,node-stdio-bug,node-conditional-bp,node-uncaught-throw --trials=1
```

`eval:quick` stays at browser `compute-step` only. The per-PR gate cost is unchanged.

---

## Phase E — Sequencing + cost

| Order | What ships | Paid cost | Notes |
|---:|---|---:|---|
| 1 | Phases A + B in one PR | $0 | Fixture (4 new entries) + 5 L3 tests. Catches integration bugs cheaply. |
| 2 | **Phase A.5 — harness Node-target seam** | $0 | `Scenario.target` discriminator + runner branch + Node system prompt. Land before any L4 scenario PR so scenario PRs stay scoped to oracle+fixture work. |
| 3 | `node-compute-step` scenario + Phase D (`eval:quick:node` + `preeval:quick:node`) | ~$0.35 | Lowest-risk canonical port. Mechanic: bp+pause+inspect (same shape as browser `compute-step`); `get_node_output` is diagnostic/optional. One Anthropic Opus-medium smoke on the PR. |
| 4 | `node-stdio-bug` scenario | ~$0.35 | `get_node_output` L4 coverage hole — high signal. Validates the raw-stdio + console-rejecting oracle. |
| 5 | `node-conditional-bp` scenario | ~$0.35 | Conditional-bp efficiency primitive on Node. Validates the condition-required oracle. |
| 6 | `node-uncaught-throw` scenario | ~$0.35 | Last because the entry-pause-vs-throw race needs careful oracle calibration (re-launch recovery still earns mechanic=1). |
| 7 (optional, post-merge) | Tri-vendor baseline run | ~$5–8 | Anthropic + OpenAI + Vertex × 4 scenarios × 1 trial. |

**Total paid validation during the work itself: ~$1.40** (4 single-vendor smokes). Tri-vendor baseline is a separate post-merge step.

---

## Critical files / patterns to reuse

| Path | Why |
|---|---|
| [`evals/scenarios/compute-step.ts`](../evals/scenarios/compute-step.ts) | Template for new scenario files |
| [`evals/scenarios/index.ts`](../evals/scenarios/index.ts) | Append the four new scenarios to `SCENARIOS` |
| [`evals/scenarios/_test-helpers.ts`](../evals/scenarios/_test-helpers.ts) | Oracle-unit-test helpers |
| [`evals/harness/trace.ts`](../evals/harness/trace.ts) → `toolPairs()` | Trace-parsing helper used by every oracle |
| [`evals/harness/types.ts`](../evals/harness/types.ts) → `Scenario`, `OracleResult`, `TraceEntry`, `ScenarioStartEntry`, `RunTrialOpts` | Type contracts. `Scenario` + `RunTrialOpts` + `ScenarioStartEntry` are extended in Phase A.5 (`target` discriminator); `OracleResult` + `TraceEntry` are unchanged. |
| [`test/e2e/node-breakpoint-flow.e2e.test.ts`](../test/e2e/node-breakpoint-flow.e2e.test.ts) | Template for new Node L3 tests |
| [`test/e2e/node-launch-flow.e2e.test.ts`](../test/e2e/node-launch-flow.e2e.test.ts) | Template for `launch_node`-driven tests |
| [`examples/sample-node-app/src/`](../examples/sample-node-app/src/) | Fixture root — add four new entry scripts here |
| [`src/session/capabilities.ts`](../src/session/capabilities.ts) → `TOOL_KIND_SUPPORT` | Cross-check at oracle-design time |

---

## Verification (when implementing)

```bash
# L1/L2 — unchanged + 4 new oracle tests pass
npm test

# L3 e2e — 5 new Node tests pass alongside the existing suite
npm run test:e2e

# L4 quick smokes — both stay green, cost preserved
npm run eval:quick           # compute-step (browser) — ~$0.33
npm run eval:quick:node      # node-compute-step (new) — ~$0.35

# L4 per-scenario validation (one paid smoke per scenario as it lands)
npm run eval -- --scenarios=node-compute-step --trials=1
npm run eval -- --scenarios=node-stdio-bug --trials=1
npm run eval -- --scenarios=node-conditional-bp --trials=1
npm run eval -- --scenarios=node-uncaught-throw --trials=1

# (Optional, post-merge) Full Node baseline, tri-vendor
npm run build && npm run sample-node:build  # required: prebuild Node fixture
npm run eval -- --scenarios=node-compute-step,node-stdio-bug,node-conditional-bp,node-uncaught-throw --trials=1
# (re-run with EVAL_PROVIDER=openai and EVAL_PROVIDER=vertex per the multi-backend pattern;
#  see evals/cli.ts for the full env-var contract)
```

**Green criteria for each implementation PR:**

- All existing L1/L2/L3 tests pass with no behavioral change.
- The 5 new L3 Node tests pass on the Linux + Chromium CI host.
- Each new L4 scenario achieves `correctness=1` + `mechanic=1` on a single-trial Opus-medium smoke before its PR merges.
- `eval:quick` cost stays at $0.33 ± 10%. New `eval:quick:node` lands at ~$0.35 ± 10%.

---

## Key design decisions

These were locked during design review and are the load-bearing rationale behind the oracle shapes above:

1. **`get_node_output` is optional (diagnostic) in `node-compute-step`, not a mechanic requirement.** Gating mechanic on it created a gameable path — `launch_node` → `get_node_output` → `evaluate` (on the `--inspect-brk` entry pause) → final — that earns mechanic without ever binding a breakpoint or hitting a bug-driven pause. Entry-pause `evaluate`/`get_call_stack`/`get_scope` all work *before* any breakpoint binds, so any "inspection forces a real pause cycle" assumption is false. Core mechanic is therefore bp+pause+inspect; `node-stdio-bug` is the sole scenario where `get_node_output` is mandatory.
2. **Breakpoint-hit detection uses `hit_breakpoint_ids` membership, never reason-equality.** V8 emits non-standard `Debugger.paused.reason` strings on Node (e.g. `"Break on start"` for the entry pause), so `reason === "other"` / `reason === "breakpoint"` checks are unsafe. Canonical check: `expect(bpHit.hit_breakpoint_ids).toContain(bp.id)` — the same shape the L3 spec uses. See [`docs/node-session-design.md`](./node-session-design.md) §7.
3. **`node-conditional-bp` is worth an L4 scenario.** Conditional breakpoints are a core efficiency primitive; leaving the highest-leverage efficiency tool unexercised at the agent tier would be the biggest coverage gap.
4. **The harness needed a Node-target seam (Phase A.5), not just prompt conventions.** The runner was browser-specific (static server, Chrome resolution, `Page under test:` framing). The `Scenario.target` discriminator gives the runner a startup-time path check and drives the static-server/Chrome-skip on `target.kind` rather than on a fragile system-prompt string.
5. **All four scenarios are `launch_node`-only.** The `target` discriminator supplies only a script path; `attach_node` would fail against a default inspector port with nothing listening. A future attach-shape can extend the discriminator with a `{ kind: "node-attach"; host; port }` variant.
6. **`node-uncaught-throw` accepts re-launch recovery.** The entry-pause-vs-throw race (the process can exit before the agent re-pauses) has no browser analogue; on Node, re-launching and setting pause-on-exceptions before the second resume is the normal recovery path, so the oracle credits mechanic rather than locking a tool ordering.
