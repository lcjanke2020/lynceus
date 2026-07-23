# Changelog

Notable changes per release. Dates are npm publish dates (UTC). Versions **0.2.2 and
earlier were published to npm as [`cdp-mcp`](https://www.npmjs.com/package/cdp-mcp)**;
the package was renamed to `lynceus` in 0.3.0 (see that entry). PR numbers reference
[this repo's pull requests](https://github.com/lcjanke2020/lynceus/pulls).

## [Unreleased]

- **React DevTools backend bridge** (LEO-359; #75–#76) — added opt-in
  `attach_react_devtools` / `detach_react_devtools` lifecycle tools backed by
  exact-pinned `react-devtools-core@7.0.1`. Per-session attachment and document
  generations fence stale, iframe, and old-navigation events; detach, target switch,
  and session close remove bindings and tracked bootstrap scripts before returning.
- **Concurrent browser + Node debugging** (LEO-115 / LEO-116 / LEO-365; #62–#72 +
  follow-up) — replaced the process-global singleton slot with a transactional
  `SessionRegistry`. One browser and one Node target can now stay live together;
  launch/attach returns monotonic `browser_N` / `node_N` IDs and optional labels,
  `list_sessions` exposes both lanes, `close_session(session?)` tears down one record,
  and process shutdown awaits `closeAll()` including in-flight Node-child cleanup.
- **Explicit session routing across the 56-tool surface** — ordinary session-scoped
  tools accept `session`; omission remains backward-compatible with one live target and
  returns `ambiguous_session` with two. The separate CDP-child `session_id` axis is now
  nullable/optional and documented consistently on all 11 tools that round-trip
  worker/iframe/OOPIF-minted IDs, including a corrective error when a debug-target ID
  is passed in the wrong field.
- **Raced waits + merged cross-session timeline** (#71) — omitted-session
  `wait_for_pause` returns whichever live target pauses first, with cancellable loser
  waiters and prompt close rejection. `get_timeline(session="all")` interleaves console,
  browser-network request-start, and Node stdout/stderr rows using registry-global
  sequence numbers and lossless forward pagination while filters stay fixed.
- **Full-stack acceptance and agent eval coverage** — a real-browser/real-Inspector L3
  flow follows one request through concurrently live sessions; the new xfailed
  `fullstack-cart` L4 scenario adds the first `Scenario.target.kind="dual"`, a managed
  Vite fixture lifecycle, and a deterministic oracle for concurrent kinds, per-session
  TS/TSX breakpoint bindings, the Node handler pause, and the body-parser-ordering
  diagnosis. README, architecture, session, eval, demo, index, and design docs now tell
  the same multi-session story.
- **`cdp-mcp` compatibility wrapper** added to the repo (#53) — `npm install cdp-mcp`
  now installs a thin shim that boots lynceus in-process and re-exports the `contract`
  subpath. Shipped separately to npm as the `cdp-mcp@0.4.0` **wrapper package**
  (2026-07-14, not part of any `lynceus` release), with all older `cdp-mcp` versions
  deprecated.
- Docs quick-fix pass (#54) — broken eval-doc link removed, npm-global wire-in
  (`claude mcp add lynceus lynceus` / npx form), stale CI job text, last rename residue.
- Per-run env knobs for the OpenAI-compatible eval adapters (#55) — output-cap override
  (`EVAL_{DEEPSEEK,MOONSHOT,LM_STUDIO}_MAX_TOKENS`) and reasoning-effort forwarding
  (`EVAL_{DEEPSEEK,LM_STUDIO}_REASONING_EFFORT`); LM Studio adapter migrated onto the
  shared factory.
- **`set_breakpoint`'s `no_mapping` error now says how to recover** (GH #37): an
  unknown file echoes the currently-mapped source paths (same-basename candidates
  first, capped at 20); a mapped file with an unmapped line suggests the nearest
  mapped line(s) (±25-line bounded probe); an empty script store says the maps may
  still be loading. Previously all three cases got the same "try list_scripts" hint —
  the dominant L4 eval failure mode was agents iterating wrong path prefixes.
  Review hardening: an explicit-column miss on a mapped line blames the column
  (suggesting a retry without it) instead of falsely claiming the line has no code,
  a map that attaches mid-call gets a plain retry hint, and verdicts reached while
  other maps are still loading say the picture may be incomplete.

## 0.4.0 — 2026-07-11

- **New tool: `get_source`** — fetch original TypeScript by file (the coordinates
  `set_breakpoint` uses), plus JS-vs-TS breakpoint mis-index diagnostics (#47).
- **Fix: `get_scope` merges lexical scopes by default** so block-scoped `let`/`const`
  variables surface (#45) — this alone moved the Node conditional-breakpoint eval
  scenario from 1/3 to 2/3 passing trials.
- Eval-harness Chromium sandbox auto-detection: tri-state `EVAL_SANDBOX=on|off|auto`
  probes the host (userns / AppArmor / SUID helper) and picks a posture (#44).
- `adversarial-out-of-order` eval scenario now exercises the pause mechanic;
  `xfailMechanic` escape hatch added (#48).
- `claude-sonnet-5` wired as an `EVAL_MODEL_OVERRIDE` opt-in (#49).
- Docs: Fedora/Qubes characterized as a validated `sandbox: true` host (#40); eval-flow
  mermaid diagram render fix (#50).
- Release/publish: npm pinned to `^11.5.1` to unblock OIDC publishing; high-severity
  audit advisories cleared (#52).

## 0.3.1 — 2026-07-07

- Version bump only — verified the OIDC trusted-publishing path (provenance) end-to-end
  after the rename; server handshake version kept in sync with `package.json` (#39).

## 0.3.0 — 2026-07-06

- **Renamed `cdp-mcp` → `lynceus`** — package, bin, server name, env vars
  (`LYNCEUS_*`, with `CDP_MCP_*` still honored as deprecated fallbacks), docs (#38).
  First release published to npm as `lynceus`. (No `v0.3.0` git tag exists; the
  repo went straight to `v0.3.1` — the npm release is the reference.)
- **Node.js Inspector debugging** ported into the public tree: `attach_node` /
  `launch_node` / `get_node_output`, shared Runtime+Debugger wiring across browser and
  Node targets, per-tool capability gating (`unsupported_target`) (#29); L3 real-Node
  e2e suite (#30); eval-harness Node-target seam + 4 Node L4 scenarios (#31);
  Node-session docs (#32).

## 0.2.2 — 2026-06-10

- Fix: `set_breakpoint` no longer returns a non-recoverable `internal_error` on
  duplicate script records (#25).

## 0.2.1 — 2026-06-10

- Dependency security updates (hono, qs, vitest) and Node-20 GitHub-Actions bump (#23).

## 0.2.0 — 2026-06-10

- **Session-portability tools**: `export_storage_state` / `load_storage_state`,
  `get_cookies` (auth-value redaction) / `set_cookies` (#15).
- **`LocatorSpec` published as the `cdp-mcp/contract` subpath export** (now
  `lynceus/contract`) with shared locator runtime (#13, #16).
- L4 agent evals for the driving + session-portability tool family (#17).
- `EVAL_SANDBOX` opt-in to run L4 evals with Chromium's sandbox on (#18).
- Default L4 eval model moved to Claude Opus 4.8 (#11).
- Docs: local L3 e2e setup (Playwright Chromium + AppArmor) (#19); repo-standalone doc
  sweep (#20); agent-operator threat model + deployment hardening (#21).

## 0.1.3 — 2026-06-07

- DeepSeek + Kimi (Moonshot) eval vendor adapters (#6), with DeepSeek reasoning replay
  and thinking parity (#9).
- Persistent service setup guides (macOS launchd, Linux systemd) (#5).

## 0.1.2 — 2026-06-05

- Fix: tool registration + keepalive over the SSE transport (#2).

## 0.1.1 — 2026-06-04

- npm publish workflow: OIDC trusted publishing with provenance attestation — no
  long-lived npm token.

## 0.1.0 — 2026-06-04

- Initial public release (as `cdp-mcp`): TypeScript-aware Chrome DevTools Protocol
  debugging over MCP — source-level breakpoints, stepping, frame-aware evaluation and
  scope inspection in TS coordinates, buffered console/network, DOM interaction and
  screenshot tools — with the four-layer test suite (unit, fake-CDP contract,
  real-Chromium e2e, LLM agent-eval harness).
