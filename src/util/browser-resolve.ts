// Shared Chromium/Chrome resolver used by BOTH the L3 e2e suite
// (test/e2e/setup/browser-path.ts re-exports from here) AND the L4 eval
// harness (evals/harness/runner.ts imports resolveBrowser() and feeds
// the result into the spawned MCP server via CHROME_PATH). Single
// resolution path so both layers cannot test against different
// protocol versions — the intent already documented in
// docs/test-eval-plan.md §L3 *Production code change required for
// chromePath* and §L3 *CI matrix* ("the same helper is reused by the
// eval harness").
//
// Resolution order (fail-fast — never silently fall back to chrome-
// launcher's auto-detection, because that's how the wrong browser ends
// up running and tests pass against the wrong protocol revision):
//   1. CDP_TEST_BROWSER_PATH env — explicit override, used by CI after
//      `npx playwright install --with-deps chromium`. Wins everything.
//   2. `which chromium` (Linux/macOS) / `where chromium.exe` (Windows) —
//      local dev path. Catches both /snap/bin/chromium and the apt
//      /usr/bin/chromium symlink.
//   3. Playwright bundled cache — ~/.cache/ms-playwright/chromium-*/
//      chrome-linux/chrome (Linux), ~/Library/Caches/ms-playwright/...
//      (macOS), %LOCALAPPDATA%\ms-playwright\... (Windows). Handy after
//      a fresh `npx playwright install`.
//   4. CDP_TEST_BROWSER=chrome — chrome-launcher's default detection.
//   5. Fail with an actionable install hint.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type BrowserChoice = "chromium" | "chrome";

export interface ResolvedBrowser {
  /** Absolute path to the Chrome/Chromium executable. */
  binaryPath: string;
  /** Which logical browser this binary represents. */
  choice: BrowserChoice;
  /** True when the binary is snap-confined (/snap/bin/* on Linux). Triggers
   *  the user-data-dir workaround in launch_chrome. */
  snapConfined: boolean;
  /** Diagnostic — which resolution step produced this. */
  source:
    | "CDP_TEST_BROWSER_PATH"
    | "which-chromium"
    | "playwright-cache"
    | "chrome-launcher-default";
}

export function getBrowserChoice(): BrowserChoice {
  const env = process.env.CDP_TEST_BROWSER?.toLowerCase();
  if (env === "chrome") return "chrome";
  if (env === "chromium" || env === undefined || env === "") return "chromium";
  throw new Error(
    `CDP_TEST_BROWSER must be 'chromium' or 'chrome' (got '${env}'). Default is 'chromium'.`,
  );
}

export function resolveBrowser(choice: BrowserChoice = getBrowserChoice()): ResolvedBrowser {
  // Step 1 — explicit override wins.
  const override = process.env.CDP_TEST_BROWSER_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `CDP_TEST_BROWSER_PATH='${override}' does not exist. Unset it or install the binary.`,
      );
    }
    return {
      binaryPath: override,
      choice,
      snapConfined: override.startsWith("/snap/"),
      source: "CDP_TEST_BROWSER_PATH",
    };
  }

  // Step 2 — system-installed chromium (Linux/macOS via `which`, Windows via
  // `where`). Skip when choice is 'chrome' — Chrome detection is delegated to
  // chrome-launcher's defaults in step 4.
  //
  // On darwin we additionally skip the deprecated Homebrew cask `chromium`
  // wrapper at /opt/homebrew/bin/chromium (and any path whose realpath
  // resolves into /opt/homebrew/Caskroom/chromium/). That wrapper points
  // at an unsigned .app Gatekeeper rejects as "damaged" — it launches
  // successfully but the debug port never opens, so chrome-launcher's
  // startup-port poll ECONNREFUSEs. The same gap is precisely what the
  // §macOS arm64 entry in docs/known-chromium-gaps.md documents; skipping
  // it here is what makes that entry's "resolveBrowser picks it up
  // automatically" claim actually true for users who tried the cask first
  // before reading the doc. Cask deprecation removal is scheduled
  // 2026-09-01; once removed this skip becomes a no-op.
  if (choice === "chromium") {
    const sys = findOnPath("chromium") ?? findOnPath("chromium-browser");
    if (sys && !isBrewCaskChromium(sys)) {
      return {
        binaryPath: sys,
        choice,
        snapConfined: sys.startsWith("/snap/"),
        source: "which-chromium",
      };
    }
  }

  // Step 3 — Playwright's bundled cache. Used in CI after
  // `npx playwright install`; also useful locally when the system chromium
  // isn't installed.
  const pw = findPlaywrightChromium();
  if (pw && choice === "chromium") {
    return {
      binaryPath: pw,
      choice,
      snapConfined: false,
      source: "playwright-cache",
    };
  }

  // Step 4 — Chrome stable, only when explicitly requested. We don't return a
  // path here; the caller forwards `undefined` to chrome-launcher, which runs
  // its own detection. This is intentionally NOT used as a silent fallback
  // for chromium because the protocol revision can diverge.
  if (choice === "chrome") {
    // chrome-launcher uses its own which() — we just signal it should take
    // over by returning the marker path "chrome-launcher-default". Both
    // callers strip this back to undefined before forwarding the path: L3
    // global setup at test/e2e/setup/global.ts skips `chromePath` entirely,
    // and the L4 runner at evals/harness/runner.ts omits CHROME_PATH from
    // the subprocess env via isChromeLauncherDefault().
    return {
      binaryPath: "chrome-launcher-default",
      choice,
      snapConfined: false,
      source: "chrome-launcher-default",
    };
  }

  // Step 5 — actionable failure.
  const isArm = process.arch === "arm64";
  const installHint = isArm
    ? "sudo apt-get install chromium-browser  # OR: npx playwright install chromium"
    : "sudo snap install chromium  OR  sudo apt-get install chromium-browser  OR  npx playwright install chromium";
  throw new Error(
    `Could not resolve a Chromium binary for the e2e suite.\n` +
      `Tried (in order): CDP_TEST_BROWSER_PATH env, which chromium, Playwright cache.\n` +
      `Install Chromium (${installHint}) or set CDP_TEST_BROWSER_PATH explicitly.`,
  );
}

// Detect the deprecated Homebrew cask `chromium` wrapper on darwin. Returns
// true for both the well-known /opt/homebrew/bin/chromium path and any path
// whose realpath resolves into /opt/homebrew/Caskroom/chromium/ (covers
// future brew layout shifts where the wrapper lives elsewhere but the
// Caskroom prefix stays put). Never true off darwin.
function isBrewCaskChromium(binaryPath: string): boolean {
  if (platform() !== "darwin") return false;
  if (binaryPath === "/opt/homebrew/bin/chromium") return true;
  try {
    const resolved = realpathSync(binaryPath);
    return resolved.startsWith("/opt/homebrew/Caskroom/chromium/");
  } catch {
    return false;
  }
}

function findOnPath(cmd: string): string | null {
  try {
    const which = platform() === "win32" ? "where" : "which";
    const out = execSync(`${which} ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    if (!out) return null;
    const path = out.trim();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function findPlaywrightChromium(): string | null {
  const candidates = playwrightCacheDirs();
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    // Filter to chromium-* / chromium-headless-shell-* — pick the highest-
    // numbered revision (newest install).
    const chromiums = entries
      .filter((e) => e.startsWith("chromium-") && !e.startsWith("chromium-headless-shell-"))
      .map((e) => ({ name: e, full: join(dir, e) }))
      .filter((e) => {
        try {
          return statSync(e.full).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const c of chromiums) {
      const exe = pickPlaywrightExe(c.full);
      if (exe) return exe;
    }
  }
  return null;
}

function playwrightCacheDirs(): string[] {
  const home = homedir();
  const plat = platform();
  if (plat === "linux") return [join(home, ".cache", "ms-playwright")];
  if (plat === "darwin") return [join(home, "Library", "Caches", "ms-playwright")];
  if (plat === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [join(local, "ms-playwright")];
  }
  return [join(home, ".cache", "ms-playwright")];
}

function pickPlaywrightExe(chromiumDir: string): string | null {
  // Layout, per Playwright's install layout:
  //   Linux:   chromium-<rev>/chrome-linux/chrome
  //   macOS:   chromium-<rev>/chrome-mac/Chromium.app/Contents/MacOS/Chromium
  //   Windows: chromium-<rev>/chrome-win/chrome.exe
  const plat = platform();
  // Playwright's layout varies by version/arch (Chrome-for-Testing renamed
  // some folders ~Playwright 1.40+):
  //   Linux x86_64:  chromium-<rev>/chrome-linux/chrome     (older)
  //                  chromium-<rev>/chrome-linux64/chrome   (CfT, newer)
  //   Linux ARM64:   chromium-<rev>/chrome-linux/chrome     (ARM64 unchanged)
  //                  chromium-<rev>/chrome-linux-arm64/chrome (rare variant)
  //   macOS x86_64:  chromium-<rev>/chrome-mac/Chromium.app/...                       (older)
  //                  chromium-<rev>/chrome-mac-x64/Google Chrome for Testing.app/...  (CfT, newer)
  //   macOS arm64:   chromium-<rev>/chrome-mac-arm/Chromium.app/...                   (older)
  //                  chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/...(CfT, newer)
  //   Windows:       chromium-<rev>/chrome-win/chrome.exe   (older)
  //                  chromium-<rev>/chrome-win64/chrome.exe (newer)
  // Codex blocker review on PR #11 flagged the missing chrome-linux64
  // candidate — modern Playwright on ubuntu-latest landed in CfT layout
  // and the resolver step exited 1 before the test runner started.
  // The mac-arm64 CfT candidates were added while validating
  // set_breakpoint idempotency on darwin-arm64, where Playwright
  // v1223+ installs to chrome-mac-arm64/Google Chrome
  // for Testing.app/Contents/MacOS/Google Chrome for Testing.
  const candidates =
    plat === "win32"
      ? [
          join(chromiumDir, "chrome-win64", "chrome.exe"),
          join(chromiumDir, "chrome-win", "chrome.exe"),
        ]
      : plat === "darwin"
        ? [
            // CfT-renamed layouts first (Playwright 1.40+ / chromium revisions
            // ~v1200+). `existsSync` makes the order forgiving — try newer
            // first so we don't accidentally pick an older sibling layout
            // when both happen to be present.
            join(
              chromiumDir,
              "chrome-mac-arm64",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
            join(
              chromiumDir,
              "chrome-mac-x64",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
            // Older Chromium.app-branded layouts.
            join(
              chromiumDir,
              "chrome-mac",
              "Chromium.app",
              "Contents",
              "MacOS",
              "Chromium",
            ),
            join(
              chromiumDir,
              "chrome-mac-arm",
              "Chromium.app",
              "Contents",
              "MacOS",
              "Chromium",
            ),
          ]
        : [
            join(chromiumDir, "chrome-linux", "chrome"),
            join(chromiumDir, "chrome-linux64", "chrome"),
            join(chromiumDir, "chrome-linux-arm64", "chrome"),
          ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** True when the given binary is the snap-marker returned by step 4. */
export function isChromeLauncherDefault(b: ResolvedBrowser): boolean {
  return b.source === "chrome-launcher-default";
}

/** Determine the user-data-dir for snap-confined Chromium. Snap confinement
 *  rejects /tmp/... paths; only ~/snap/<app>/current/ is writable. */
export function snapUserDataDir(binaryPath: string): string {
  // Parse the snap app name out of the binary path. /snap/bin/chromium ->
  // 'chromium'; /snap/firefox/current/firefox -> 'firefox'.
  const match = binaryPath.match(/\/snap\/(?:bin\/)?([^/]+)/);
  const app = match?.[1] ?? "chromium";
  return join(homedir(), "snap", app, "current", "cdp-mcp-test-profile");
}
