# Contributing

**Last updated: 2026-07-14**

Thanks for your interest in lynceus! This is an alpha-stage project; issues and
PRs are welcome.

## Getting started

```sh
npm install
npm run build
npm test          # L1 unit + L2 contract tests (fast, no browser)
npm run typecheck # both tsconfigs — CI gates on this
npm run smoke     # stdio protocol smoke, no browser — CI gates on this
```

For the end-to-end and eval layers, see [README.md](./README.md) and
[docs/test-eval-plan.md](./docs/test-eval-plan.md). New to the codebase? Start
with [AGENTS.md](./AGENTS.md) and [INDEX.md](./INDEX.md) — they map the repo and
explain the layered test pyramid (L1 unit → L2 fake-CDP contract → L3 real
browser e2e → L4 LLM agent evals).

## Pull requests

- **Conventional Commits** for the title: `<type>: <subject>` (`feat`, `fix`,
  `docs`, `test`, `test+eval`, `chore`).
- **`npm test`, `npm run typecheck`, and `npm run smoke` must pass** for any code
  change (CI gates on all three). If you touch the browser-facing paths, run
  `npm run test:e2e` locally (needs a local Chromium/Chrome).
- Add an L2 contract test in `test/tools/<file>.test.ts` for new or changed MCP
  tools, and update the tool catalog in `src/tools/README.md`.
- Add a line under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md) for
  user-visible changes.
- Keep changes focused; describe the user-facing effect and how you verified it.

## Adding a new MCP tool

See the five-step pattern in [src/tools/README.md](./src/tools/README.md).

## Reporting security issues

Please do **not** open a public issue for vulnerabilities — see
[SECURITY.md](./SECURITY.md).
