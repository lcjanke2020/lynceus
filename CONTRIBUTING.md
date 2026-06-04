# Contributing

Thanks for your interest in cdp-mcp! This is an alpha-stage project; issues and
PRs are welcome.

## Getting started

```sh
npm install
npm run build
npm test          # L1 unit + L2 contract tests (fast, no browser)
```

For the end-to-end and eval layers, see [README.md](./README.md) and
[docs/test-eval-plan.md](./docs/test-eval-plan.md). New to the codebase? Start
with [AGENTS.md](./AGENTS.md) and [INDEX.md](./INDEX.md) — they map the repo and
explain the layered test pyramid (L1 unit → L2 fake-CDP contract → L3 real
browser e2e → L4 LLM agent evals).

## Pull requests

- **Conventional Commits** for the title: `<type>: <subject>` (`feat`, `fix`,
  `docs`, `test`, `chore`).
- **`npm test` must pass** for any code change. If you touch the browser-facing
  paths, run `npm run test:e2e` locally (needs a local Chromium/Chrome).
- Add an L2 contract test in `test/tools/<file>.test.ts` for new or changed MCP
  tools, and update the tool catalog in `src/tools/README.md`.
- Keep changes focused; describe the user-facing effect and how you verified it.

## Adding a new MCP tool

See the five-step pattern in [src/tools/README.md](./src/tools/README.md).

## Reporting security issues

Please do **not** open a public issue for vulnerabilities — see
[SECURITY.md](./SECURITY.md).
