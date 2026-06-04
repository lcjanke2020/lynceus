# Known Chromium gaps

Specs in the L3 e2e suite that fail (or fail intermittently) on Chromium but
pass on Chrome stable. Every entry below is a real coverage gap on Linux
ARM64 + Chromium (the day-1 primary target) — not a CI-only concession.

If the gap is mitigatable in production code, link the fix PR. If it's a CDP
protocol-version difference, link the Chromium release that includes the fix.

| Spec | Skip tag | CDP method missing/changed | Chromium version that fixes it | Tracking |
|---|---|---|---|---|
| _none yet — populate as L3 lands_ | | | | |

## Pre-flagged risks (not yet observed; documented for triage)

These are known protocol-version-sensitive areas the test+eval plan flagged
as risky during planning. Add a row above when one of them actually fires
on the e2e suite.

- **`Network.loadNetworkResource`** — Used by `src/sourcemap/loader.ts:113`
  to fetch source maps through the browser's network stack (so cookies/
  origin/auth flow naturally). Older Chromium revisions ship a more limited
  param set (no `options.includeCredentials`, no `options.disableCache`);
  the production code already has a Node-fetch fallback, but verify the
  fallback path is exercised under the older Chromium.

- **`Page.captureScreenshot`** flag set — `captureBeyondViewport` and
  `quality` (when `format=jpeg`) gained options across versions. The
  screenshot e2e spec asserts byte-shape, not flag-respect, so this is
  most likely to surface as a "bytes don't match" assertion under older
  Chromium.

## Conventions

- Add a `// @chromium-skip — <gap-id>` comment on the spec's `it()` line.
- Set the spec to `it.skipIf(process.env.CDP_TEST_BROWSER === "chromium")` or
  use vitest's `.skip` with a runtime check.
- Every skip MUST have a corresponding row in the table above. **Enforced** by
  `scripts/check-chromium-skips.mjs` — runs as `pretest:e2e` on every PR and
  also as `npm run lint:chromium-skips`. Greps `test/e2e/**/*.test.ts` for
  `@chromium-skip` tags and `it.skipIf`/`describe.skipIf` Chromium guards,
  parses the table above, exits 1 if any skip lacks a row OR any row points
  at a spec that no longer exists. Zero-skip state (the current state) is
  fine — the script is a no-op.

_(no entries below this line yet means no L3 specs needed a Chromium skip)_

## Known host gaps (not Chromium-version issues)

These are host/library combinations where the e2e suite cannot run end-to-
end, separate from the per-Chromium-version skip mechanism above. Listed
here so future contributors don't waste a debug cycle.

- **Windows 11 + chrome-launcher 1.2.1.** `chrome-launcher.launch()`'s
  internal startup-port poll always fails with `ECONNREFUSED` on this Win11
  configuration, regardless of headless mode (`--headless=new`, classic
  `--headless`, or non-headless), browser (Chrome stable from Program
  Files, Playwright-bundled Chromium under `~/AppData/Local/ms-playwright/
  chromium-XXXX/chrome-win64/chrome.exe`), or how the port is selected
  (chrome-launcher-managed vs explicit). Spawning `chrome.exe` directly via
  `Start-Process` and probing `/json/version` over HTTP works fine — only
  chrome-launcher's launch path fails. The same code works on Linux (CI)
  and is widely used elsewhere, so this is a Windows-host quirk rather
  than a cdp-mcp issue. **Workaround**: run L3 changes under WSL2
  (Ubuntu) or push and let CI validate (but see WSL2 caveat below). Unit
  + L2 tests work fine on native Windows.

  *Originally hit on agents/l3-impl during PR #11 implementation.
  Cross-confirmed by Codex reviewer who diagnosed the on-CI failure
  separately — turned out to be a different root cause (Codex blocker on
  --remote-debugging-port=0 in chromeFlags overriding chrome-launcher's
  own port). After that fix, CI on Linux is the live validation; Win11
  local-host status remains as documented here.*

- **macOS arm64 + system unbranded Chromium (brew cask).** The `chromium`
  Homebrew cask is **deprecated** ("does not pass the macOS Gatekeeper
  check; will be disabled 2026-09-01"). Install completes and the wrapper
  script lands at `/opt/homebrew/bin/chromium`, but on first launch
  Gatekeeper rejects the `.app` as "damaged" and the binary is unusable
  for unattended e2e/eval runs. Workaround for darwin-arm64: use Playwright
  Chrome-for-Testing (`npx playwright install chromium`) — `resolveBrowser`
  picks it up automatically from `~/Library/Caches/ms-playwright/chromium-
  <rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/
  Google Chrome for Testing` (CfT layout added to `pickPlaywrightExe` in
  the same PR that landed this entry). The resolver also explicitly skips
  the brew-cask wrapper on darwin (`isBrewCaskChromium`) so users who
  tried the deprecated cask first — and then turn to Playwright per this
  entry — fall through to the Playwright cache instead of getting the
  Gatekeeper-rejected wrapper back from Step 2. Functionally Chromium-
  channel at a fixed protocol revision, but Google-branded — call it out
  if your eval needs *unbranded* Chromium. Building Chromium from source
  on macOS is multi-hour + multi-GB ongoing maintenance; not a viable
  automation path.

  *Originally hit while validating set_breakpoint idempotency on a
  macOS arm64 host.*

- **WSL2 (Ubuntu) + snap-installed chromium.** Default-template Ubuntu on
  WSL2 ships chromium as a snap (`/snap/bin/chromium`), which runs in a
  confined namespace. chrome-launcher launches the binary successfully
  (visible window appears under WSLg) but its startup-port poll
  `ECONNREFUSEs` on iter 1 and often iter 2 — the debug port either
  binds to a different port than chrome-launcher polled (race) or is
  invisible across the snap sandbox boundary. After 2-4 retries the
  agent's tool-use loop eventually picks an instance that responds, so
  the eval does run, but every trial pays an inflated cost in retry
  iterations and the trace is contaminated with WARN entries that look
  like real failures. Same chrome-launcher code path is clean on macOS,
  Linux native, and Linux CI.

  **Workaround options**: (a) **prefer macOS or Linux native** for
  interactive eval iteration — a macOS arm64 host confirmed clean;
  (b) install non-snap chromium in WSL2 via apt or
  symlink Playwright's bundled chromium to `/usr/local/bin/chromium-browser`
  before the snap path; (c) accept the noise and rely on CI for the
  authoritative signal. Don't rely on WSL2 for eval validation runs.

  *A re-run on the same commit (`f0ce92a`) on a native host showed 0
  chrome-launcher errors, isolating the cause to the WSL2 + snap-chromium
  combination rather than the harness.*

- **Ubuntu 23.10+ (incl. 24.04) + Playwright-bundled Chromium.** Recent
  Ubuntu kernels restrict unprivileged user namespaces via AppArmor, and
  Playwright-bundled Chromium ships without a SUID `chrome_sandbox`
  helper. Without `--no-sandbox`, Chromium FATALs at startup
  (`zygote_host_impl_linux.cc: No usable sandbox!`) before opening its
  debug port — chrome-launcher's port-poll loop then times out with
  ECONNREFUSED, looking exactly like the WSL2/snap gap above but with a
  different root cause. **Mitigation:** `launchChrome` defaults
  `sandbox: false` so `--no-sandbox` is added automatically; eval
  pipelines on this host work out-of-the-box. For the full security model,
  including `sandbox: true`, AppArmor, snap confinement, and Bubblewrap, see
  [docs/chromium-sandboxing.md](./chromium-sandboxing.md).

  *First observed on an Ubuntu 24.04 arm64 host (Parallels VM) while
  validating the L4 eval suite. Quick eval went from FAIL/$0.34/445s
  (chrome-launcher retry storm) to PASS/$0.31/107s once `--no-sandbox`
  was the default.*
