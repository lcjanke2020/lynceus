<!-- Title: Conventional Commits — <type>: <subject>  (feat, fix, docs, test, chore) -->

## What & why

<!-- The user-facing effect, and the problem it solves. Link the issue if one exists. -->

## Verification

<!-- Keep the lines that apply; say briefly how you verified. -->

- [ ] `npm test` (L1 unit + L2 contract) passes
- [ ] `npm run typecheck` passes
- [ ] `npm run smoke` passes
- [ ] `npm run test:e2e` run locally (required if browser-facing paths changed; needs local Chromium/Chrome)

## For tool changes

- [ ] L2 contract test added/updated in `test/tools/<file>.test.ts`
- [ ] Tool catalog updated in `src/tools/README.md` (and the pinned surface test, if the tool set changed)

## Housekeeping

- [ ] CHANGELOG.md updated under `[Unreleased]` (user-visible changes)
- [ ] Diff is focused — unrelated cleanups split out
