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
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type BrowserChoice = "chromium" | "chrome";

/** Sentinel `binaryPath` returned by `resolveBrowser()` when it defers binary
 *  detection to chrome-launcher (`CDP_TEST_BROWSER=chrome`). It is NOT a real
 *  filesystem path — there is no resolved binary to probe until launch. */
export const CHROME_LAUNCHER_DEFAULT_MARKER = "chrome-launcher-default";

export interface ResolvedBrowser {
  /** Absolute path to the Chrome/Chromium executable — or, when `source` is
   *  `"chrome-launcher-default"`, the `CHROME_LAUNCHER_DEFAULT_MARKER`
   *  sentinel, which is NOT a filesystem path (chrome-launcher detects the
   *  binary itself at launch). Callers that treat this as a path must handle
   *  the sentinel (see `isChromeLauncherDefault`/`detectSandboxCapability`). */
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
      binaryPath: CHROME_LAUNCHER_DEFAULT_MARKER,
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

// ---------------------------------------------------------------------------
// Chromium sandbox capability detection
//
// Answers "can THIS resolved Chromium binary create a usable sandbox on THIS
// host?" — a host+binary decision, not a Chrome flag (docs/chromium-
// sandboxing.md). Consumed by the L4 eval harness to default the model-driven
// Chromium to sandbox-on when the host supports it (evals/harness/sandbox.ts)
// and by any caller that wants to avoid the `zygote_host_impl_linux.cc: No
// usable sandbox!` FATAL + chrome-launcher ECONNREFUSED that follows a
// sandbox-on launch on an incapable host.
//
// Detection is STATIC (reads sysctls + AppArmor profiles); it does not launch
// Chromium. It is deliberately conservative — it only reports `capable: true`
// when a known-good path exists, so a false negative degrades to the working
// `--no-sandbox` default rather than a hard launch failure.
// ---------------------------------------------------------------------------

export interface SandboxCapability {
  /** True when a working Chromium sandbox path exists for this binary+host. */
  capable: boolean;
  /** Human-readable rationale — surfaced in the eval run header. */
  reason: string;
}

/** Injection seam so the detector is unit-testable without a real host.
 *  Every method has a real-filesystem default (see `defaultSandboxProbe`). */
export interface SandboxProbe {
  platform: () => NodeJS.Platform;
  /** Read a sysctl-style integer file; null if absent/unreadable/empty. */
  readSysctlInt: (path: string) => number | null;
  /** Path to a working SUID-root chrome sandbox helper for `binaryPath`, or
   *  null. A functional setuid helper makes the sandbox work independently of
   *  unprivileged user namespaces. */
  suidSandboxHelper: (binaryPath: string) => string | null;
  /** Name of an AppArmor profile that attaches to `binaryPath` AND grants
   *  the `userns` permission, or null. NOTE: the default probe infers this
   *  from /etc/apparmor.d — where profiles auto-load at boot — and does NOT
   *  verify the kernel's loaded-profile state (that list is root-only). A
   *  profile dropped in since boot and never `apparmor_parser`-loaded can
   *  therefore still be reported here. Relevant only when the kernel
   *  restricts unprivileged user namespaces (Ubuntu 23.10+/24.04). */
  appArmorUsernsProfile: (binaryPath: string) => string | null;
}

export function detectSandboxCapability(
  binaryPath: string,
  probe: SandboxProbe = defaultSandboxProbe,
): SandboxCapability {
  // No resolved binary to probe (chrome-launcher will detect Chrome at launch).
  // We can't verify a sandbox path for an unknown binary, so stay conservative:
  // incapable → --no-sandbox, and force-on fails fast with actionable guidance.
  if (binaryPath === CHROME_LAUNCHER_DEFAULT_MARKER) {
    return {
      capable: false,
      reason:
        "browser path is chrome-launcher's own detection marker (CDP_TEST_BROWSER=chrome); the actual binary is unknown until launch. Set CDP_TEST_BROWSER_PATH to a concrete binary so it can be probed; request sandbox-on separately via EVAL_SANDBOX=on",
    };
  }

  const plat = probe.platform();
  if (plat === "darwin" || plat === "win32") {
    // macOS/Windows: Chromium's sandbox works without the unprivileged-userns
    // / AppArmor gymnastics that make Linux the hard case.
    return {
      capable: true,
      reason: `${plat}: Chromium's sandbox works without host userns/AppArmor setup`,
    };
  }
  if (plat !== "linux") {
    // Exotic platform (freebsd/openbsd/sunos/android/…): no verified Chromium
    // sandbox story here, so don't claim capable. Falls back to --no-sandbox.
    return {
      capable: false,
      reason: `${plat}: no verified Chromium sandbox path — defaulting to --no-sandbox`,
    };
  }

  // A SUID-root sandbox helper is a working sandbox path on its own, even when
  // unprivileged user namespaces are locked down.
  const suid = probe.suidSandboxHelper(binaryPath);
  if (suid) {
    return { capable: true, reason: `SUID-root chrome sandbox helper present (${suid})` };
  }

  // Otherwise the sandbox relies on unprivileged user namespaces. Require
  // POSITIVE evidence they are usable: a readable, nonzero
  // user.max_user_namespaces. Unreadable/absent (null) is unknown, and an
  // unknown userns state must degrade to incapable (→ --no-sandbox), not be
  // assumed available — the detector's whole job is to avoid claiming capable
  // on a host where the sandbox-on launch would then FATAL.
  const maxUserns = probe.readSysctlInt("/proc/sys/user/max_user_namespaces");
  if (maxUserns === null) {
    return {
      capable: false,
      reason:
        "could not read user.max_user_namespaces and no SUID sandbox helper is present — cannot confirm a usable sandbox path",
    };
  }
  if (maxUserns === 0) {
    return {
      capable: false,
      reason:
        "unprivileged user namespaces are disabled (user.max_user_namespaces=0) and no SUID sandbox helper is present",
    };
  }

  // Debian and pre-23.10 Ubuntu kernels carry a distro patch that gates
  // unprivileged userns creation behind kernel.unprivileged_userns_clone —
  // explicitly 0 disables it even while user.max_user_namespaces stays
  // nonzero. The knob does not exist on unpatched kernels (Fedora etc.),
  // where an absent read (null) means no such restriction.
  const usernsClone = probe.readSysctlInt(
    "/proc/sys/kernel/unprivileged_userns_clone",
  );
  if (usernsClone === 0) {
    return {
      capable: false,
      reason:
        "unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0) and no SUID sandbox helper is present",
    };
  }

  // Ubuntu 23.10+/24.04 gate unprivileged userns behind AppArmor. The knob is
  // absent on non-AppArmor hosts (Fedora/SELinux), where userns is unrestricted.
  const restrict = probe.readSysctlInt(
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  );
  if (restrict === 1) {
    const prof = probe.appArmorUsernsProfile(binaryPath);
    if (prof) {
      return {
        capable: true,
        reason: `AppArmor restricts unprivileged userns, but profile '${prof}' grants userns to ${binaryPath}`,
      };
    }
    return {
      capable: false,
      reason: `AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and no AppArmor profile was found that grants 'userns' to ${binaryPath}`,
    };
  }

  const detail =
    restrict === 0
      ? "kernel.apparmor_restrict_unprivileged_userns=0"
      : "no AppArmor unprivileged-userns restriction present";
  return {
    capable: true,
    reason: `unprivileged user namespaces are available (${detail})`,
  };
}

const defaultSandboxProbe: SandboxProbe = {
  platform,
  readSysctlInt(path) {
    try {
      const s = readFileSync(path, "utf8").trim();
      if (!s) return null;
      const n = Number.parseInt(s.split(/\s+/)[0]!, 10);
      return Number.isNaN(n) ? null : n;
    } catch {
      return null;
    }
  },
  suidSandboxHelper(binaryPath) {
    const dir = dirname(binaryPath);
    const candidates = [
      process.env.CHROME_DEVEL_SANDBOX,
      join(dir, "chrome_sandbox"),
      join(dir, "chrome-sandbox"),
    ].filter((c): c is string => Boolean(c));
    for (const c of candidates) {
      try {
        const st = statSync(c);
        let execAllowed = true;
        try {
          accessSync(c, fsConstants.X_OK);
        } catch {
          execAllowed = false;
        }
        if (
          isUsableSuidHelper({
            isFile: st.isFile(),
            uid: st.uid,
            mode: st.mode,
            execAllowed,
          })
        ) {
          return c;
        }
      } catch {
        /* missing/unreadable candidate — skip */
      }
    }
    return null;
  },
  appArmorUsernsProfile(binaryPath) {
    // Parse /etc/apparmor.d/ (world-readable) rather than
    // /sys/kernel/security/apparmor/profiles (root-only, and carries no
    // attachment path anyway). Profiles there auto-load at boot, so presence
    // ≈ loaded in practice (docs/chromium-sandboxing.md).
    const dir = "/etc/apparmor.d";
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return null;
    }
    for (const f of files) {
      const full = join(dir, f);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const p of parseAppArmorProfiles(text)) {
        if (profileGrantsUserns(p.body) && matchAppArmorPath(p.attach, binaryPath)) {
          return p.name;
        }
      }
    }
    return null;
  },
};

/** Parse AppArmor profile declarations that attach to a filesystem path.
 *  Returns `{ name, attach, body }` per profile — `attach` is the raw
 *  attachment glob, `body` is the text between the header `{` and the next
 *  line-leading `}`. Exported for unit testing. */
export function parseAppArmorProfiles(
  text: string,
): { name: string; attach: string; body: string }[] {
  const out: { name: string; attach: string; body: string }[] = [];
  const lines = text.split(/\r?\n/);
  // Header forms:
  //   profile <name> <path> [flags=(...)] {
  //   <path> [flags=(...)] {          (unnamed — name defaults to the path)
  // The path glob may end in `}` (e.g. `.../{chrome,headless_shell}`), so the
  // middle is `[^{\n]*` up to the opening brace — do NOT anchor a `\b` right
  // after the path token (a `}`→space transition is not a word boundary and
  // would drop the profile).
  const headerRe = /^\s*(?:profile\s+(\S+)\s+)?("[^"]+"|\/\S+)\s*[^{\n]*\{\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = headerRe.exec(lines[i]!);
    if (!m) continue;
    let attach = m[2]!;
    if (attach.startsWith('"')) attach = attach.slice(1, -1);
    if (!attach.startsWith("/")) continue; // only filesystem-attached profiles
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\}/.test(lines[j]!)) break;
      bodyLines.push(lines[j]!);
    }
    out.push({ name: m[1] ?? attach, attach, body: bodyLines.join("\n") });
  }
  return out;
}

/** True when a stat result describes a *usable* SUID-root sandbox helper: a
 *  regular file owned by root (uid 0) with the setuid bit, at least one execute
 *  bit, AND executable by the *current process* (`execAllowed`, access(2) X_OK).
 *  The last requirement rejects modes like `04700`/`04750` where an execute bit
 *  exists but this (non-root) process still can't execve the helper — a false
 *  positive that would report capable and then FATAL at sandbox-on launch.
 *  Playwright ships a `chrome_sandbox` next to the binary but does not set it
 *  setuid, so that copy is correctly excluded too. Exported for unit testing. */
export function isUsableSuidHelper(st: {
  isFile: boolean;
  uid: number;
  mode: number;
  /** Whether the current process may execute the file — access(2) X_OK.
   *  access() checks the real uid/gid while execve() checks the effective
   *  ones; they are the same for the eval harness, and a mismatch only
   *  produces a false negative (conservative). */
  execAllowed: boolean;
}): boolean {
  return (
    st.isFile &&
    st.uid === 0 &&
    (st.mode & 0o4000) !== 0 && // setuid bit
    (st.mode & 0o111) !== 0 && // at least one execute bit (owner/group/other)
    st.execAllowed // ...and one this process can actually use
  );
}

/** True when an AppArmor profile body contains an ALLOW rule that grants the
 *  `userns` permission. Conservative: comments are stripped first, and any
 *  `deny`-qualified line is excluded — so `# userns` or `deny userns,` do NOT
 *  count as granting it (a false positive there would report a host capable and
 *  then FATAL at sandbox-on launch). Exported for unit testing. */
export function profileGrantsUserns(body: string): boolean {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); // strip trailing comment
    if (!line || /\bdeny\b/.test(line)) continue;
    // A userns access rule, optionally prefixed with audit/allow and optionally
    // carrying an access spec (e.g. `userns create,`), terminated by a comma.
    if (/^(?:audit\s+)?(?:allow\s+)?userns\b[^,]*,$/.test(line)) return true;
  }
  return false;
}

/** Match an AppArmor path glob against a concrete path. Supports `*`
 *  (any run of non-`/`), `**` (any run including `/`), `?` (one non-`/`),
 *  `{a,b}` alternation, and `[...]` char classes. Exported for unit testing. */
export function matchAppArmorPath(glob: string, target: string): boolean {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map(escapeRe)
          .join("|");
        re += `(?:${alts})`;
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += glob.slice(i, end + 1); // pass the char class through verbatim
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  re += "$";
  return new RegExp(re).test(target);
}

/** Determine the user-data-dir for snap-confined Chromium. Snap confinement
 *  rejects /tmp/... paths; only ~/snap/<app>/current/ is writable. */
export function snapUserDataDir(binaryPath: string): string {
  // Parse the snap app name out of the binary path. /snap/bin/chromium ->
  // 'chromium'; /snap/firefox/current/firefox -> 'firefox'.
  const match = binaryPath.match(/\/snap\/(?:bin\/)?([^/]+)/);
  const app = match?.[1] ?? "chromium";
  return join(homedir(), "snap", app, "current", "lynceus-test-profile");
}
