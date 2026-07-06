// Vitest globalSetup/Teardown for L3 e2e.
//
// Responsibilities:
//   - Verify the sample-app dist exists (built by `npm run pretest:e2e` or
//     manually via `npm run sample:build`).
//   - Start a static server on port 0 serving the sample-app dist.
//   - Resolve the Chromium binary via test/e2e/setup/browser-path.ts.
//   - Launch a single headless Chromium via chrome-launcher (which manages
//     the --remote-debugging-port flag itself; passing one in chromeFlags
//     overrode its choice and caused ECONNREFUSED — see chromeFlags below
//     and Codex PR #11 review B1) and publish the chosen port via a
//     tempfile (NOT via process.env — vitest with pool=forks runs each
//     test file in a fresh worker process that doesn't inherit env vars
//     set in globalSetup. The helper in build-tools.ts reads the tempfile
//     on first use).
//   - On teardown: close the server, kill the Chrome process (SIGKILL fallback
//     because chrome.kill() can hang on worker crash).
//
// Why launch Chrome in globalSetup instead of per-spec: real-browser launch
// costs several seconds. Specs share one Chrome — isolation between specs
// is provided by close_session in the shared afterEach (test/e2e/setup/
// after-each.ts), which calls sessionState.reset() and ScriptStore.clear().

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, type LaunchedChrome } from "chrome-launcher";
import { startStaticServer, type RunningServer } from "./static-server.js";
import {
  resolveBrowser,
  snapUserDataDir,
  isChromeLauncherDefault,
} from "./browser-path.js";

const SAMPLE_APP_DIST = join(
  process.cwd(),
  "examples",
  "sample-app",
  "dist",
);
const SAMPLE_NODE_APP_ENTRY = join(
  process.cwd(),
  "examples",
  "sample-node-app",
  "dist",
  "index.js",
);
const CACHE_DIR = join(process.cwd(), ".vitest-cache");
export const CONFIG_FILE = join(CACHE_DIR, "e2e-config.json");

let runningServer: RunningServer | null = null;
let runningChrome: LaunchedChrome | null = null;

export interface E2eConfig {
  serverUrl: string;
  serverPort: number;
  chromePort: number;
  browserSource: string;
  browserBinary: string;
}

export async function setup(): Promise<void> {
  if (!existsSync(SAMPLE_APP_DIST)) {
    throw new Error(
      `e2e globalSetup: ${SAMPLE_APP_DIST} not found. Run 'npm run sample:build' first.`,
    );
  }
  if (!existsSync(SAMPLE_NODE_APP_ENTRY)) {
    throw new Error(
      `e2e globalSetup: ${SAMPLE_NODE_APP_ENTRY} not found. Run 'npm run sample-node:build' first.`,
    );
  }
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  // 1. Static server.
  runningServer = await startStaticServer(SAMPLE_APP_DIST);

  // 2. Resolve and launch Chromium.
  const resolved = resolveBrowser();
  // Do NOT include --remote-debugging-port=0 here. chrome-launcher picks
  // its own port and polls it; our flag would override Chrome's actual
  // port choice while chrome-launcher waits on the stale one (ECONNREFUSED).
  // Fix mirrors src/session/browser.ts; flagged as a Codex blocker on PR #11.
  const chromeFlags = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,site-per-process",
  ];
  if (process.env.CI) {
    // CI runners often lack the sandbox prerequisites; documented Chromium
    // recommendation. NOT used locally (we want the sandbox when we can).
    chromeFlags.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  const launchOpts: Parameters<typeof launch>[0] = {
    chromeFlags,
    startingUrl: "about:blank",
  };
  if (!isChromeLauncherDefault(resolved)) {
    launchOpts.chromePath = resolved.binaryPath;
  }
  if (resolved.snapConfined) {
    // Snap confinement rejects /tmp/... user-data-dir; ~/snap/<app>/current/
    // is the only writable path. (Plan: Critical gotchas → Snap-confined
    // Chromium.)
    //
    // chrome-launcher opens chrome-out.log inside userDataDir before
    // launching Chrome, so the directory must exist or it crashes with
    // ENOENT on first run. The .vitest-cache/ tempfile sibling above
    // gets the same treatment; do it here too. (Issue #13.)
    const udd = snapUserDataDir(resolved.binaryPath);
    mkdirSync(udd, { recursive: true });
    launchOpts.userDataDir = udd;
  }

  runningChrome = await launch(launchOpts);

  // Write the handoff file. process.env in vitest's globalSetup does NOT
  // propagate to worker forks; specs read this JSON via the helper in
  // build-tools.ts. Also set process.env for any in-process consumers (the
  // hook below, debug scripts, etc.) — same source-of-truth, two surfaces.
  const cfg: E2eConfig = {
    serverUrl: runningServer.url,
    serverPort: runningServer.port,
    chromePort: runningChrome.port,
    browserSource: resolved.source,
    browserBinary: resolved.binaryPath,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  process.env.CDP_TEST_SERVER_URL = cfg.serverUrl;
  process.env.CDP_TEST_SERVER_PORT = String(cfg.serverPort);
  process.env.CDP_TEST_CHROME_PORT = String(cfg.chromePort);
  process.env.CDP_TEST_BROWSER_SOURCE = cfg.browserSource;
  process.env.CDP_TEST_BROWSER_BINARY = cfg.browserBinary;
}

export async function teardown(): Promise<void> {
  try {
    if (runningChrome) {
      try {
        runningChrome.kill();
      } catch {
        /* ignore */
      }
      // SIGKILL fallback. chrome.kill() sends SIGTERM and may hang on slow
      // shutdown; force-kill after a short grace period.
      const pid = runningChrome.pid;
      runningChrome = null;
      if (typeof pid === "number") {
        // .unref() so a clean teardown doesn't have to wait an extra 500ms
        // for this timer to fire — if Chrome is already dead, we exit
        // immediately (Opus PR #11 review nit 10).
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }, 500).unref();
      }
    }
  } finally {
    if (runningServer) {
      await runningServer.close();
      runningServer = null;
    }
  }
}
