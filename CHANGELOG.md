# Changelog

Notable changes per release. Dates are npm publish dates (UTC). Versions **0.2.2 and
earlier were published to npm as [`cdp-mcp`](https://www.npmjs.com/package/cdp-mcp)**;
the package was renamed to `lynceus` in 0.3.0 (see that entry). PR numbers reference
[this repo's pull requests](https://github.com/lcjanke2020/lynceus/pulls).

## [Unreleased]

- **`cdp-mcp` compatibility wrapper** (#53) — `npm install cdp-mcp` now installs a thin
  shim that boots lynceus in-process and re-exports the `contract` subpath; published as
  `cdp-mcp@0.4.0` (2026-07-14), with all older `cdp-mcp` versions deprecated on npm.
- Docs quick-fix pass (#54) — broken eval-doc link removed, npm-global wire-in
  (`claude mcp add lynceus lynceus` / npx form), stale CI job text, last rename residue.
- Per-run env knobs for the OpenAI-compatible eval adapters (#55) — output-cap override
  (`EVAL_{DEEPSEEK,MOONSHOT,LM_STUDIO}_MAX_TOKENS`) and reasoning-effort forwarding
  (`EVAL_{DEEPSEEK,LM_STUDIO}_REASONING_EFFORT`); LM Studio adapter migrated onto the
  shared factory.

## 0.4.0 — 2026-07-11

- **New tool: `get_source`** — fetch original TypeScript by file (the coordinates
  `set_breakpoint` uses), plus JS-vs-TS breakpoint mis-index diagnostics (#47).
- **Fix: `get_scope` merges lexical scopes by default** so block-scoped `let`/`const`
  variables surface (#45) — together with `get_source`, this moved the Node
  conditional-breakpoint eval scenario from 1/3 to 2/3 passing trials.
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
