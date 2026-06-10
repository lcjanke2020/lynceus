// L3 end-to-end config — real headless Chromium against a built sample-app.
// Kept separate from vitest.config.ts so `npm test` stays browser-free.
//
// Constraints, all from the test+eval plan:
//   - pool=forks + fileParallelism=false — two specs cannot share Chrome
//     safely, so specs run sequentially (one file at a time). Each spec ends
//     with close_session via the shared afterEach in test/e2e/setup/
//     after-each.ts (N-6 fix in plan rev 4: relying on per-spec discipline
//     alone was brittle because a thrown assertion would leak open-session
//     state to the next spec).
//     [Vitest 4: `poolOptions.forks.singleFork` was removed in the pool
//     rework; `fileParallelism: false` is the supported replacement that
//     keeps e2e specs from running concurrently against one Chrome.]
//   - Higher timeouts than L1/L2 because real-browser launch + sample-app
//     build account for several seconds even on warm CI runners.
//   - retry(1) by default; per-spec escalation to retry(2) requires a tracked
//     flake row in docs/known-chromium-gaps.md (plan rev 2 M-4).
//
// The static server + Chrome are spun up in globalSetup (test/e2e/setup/
// global.ts) and exposed via env vars (CDP_TEST_SERVER_URL,
// CDP_TEST_CHROME_PORT). globalTeardown SIGKILLs any tracked chrome.pid.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    pool: "forks",
    fileParallelism: false,
    globalSetup: ["./test/e2e/setup/global.ts"],
    setupFiles: ["./test/e2e/setup/after-each.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 1,
  },
});
