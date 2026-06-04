// Default vitest config — runs L1 (pure-data unit tests in src/**) + L2 (per-
// tool contract tests under test/** backed by the fake CDP) + L4 harness
// unit tests under evals/**. `npm test` invokes this directly. The e2e
// project is a separate config (see vitest.e2e.config.ts) so real-Chromium
// runs stay opt-in and can use a distinct pool/timeout regime. The actual
// LLM eval runs go through `npm run eval` / `evals/cli.ts`, not vitest.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    // The e2e suite has its own config (vitest.e2e.config.ts); excluding here
    // ensures `npm test` never tries to launch Chrome and never imports the
    // e2e globalSetup which would fail without a built sample-app.
    exclude: ["test/e2e/**", "node_modules/**", "dist/**"],
  },
});
