// Unit tests for the Chromium sandbox capability detector and its AppArmor
// glob/profile parsing helpers (browser resolution itself is exercised in the
// e2e layer). The detector takes an injectable `SandboxProbe`, so every host
// shape is synthetic here — no real sysctls or /etc/apparmor.d reads.

import { describe, it, expect } from "vitest";
import {
  detectSandboxCapability,
  matchAppArmorPath,
  parseAppArmorProfiles,
  type SandboxProbe,
} from "./browser-resolve.js";

/** A probe that reports "nothing special" — Linux, no SUID helper, no AppArmor
 *  profile, and whatever sysctls the test supplies. */
function probe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: () => "linux",
    readSysctlInt: () => null,
    suidSandboxHelper: () => null,
    appArmorUsernsProfile: () => null,
    ...overrides,
  };
}

const BIN = "/opt/chromium/chrome";

describe("detectSandboxCapability", () => {
  it("non-Linux hosts are always capable (native sandbox)", () => {
    for (const plat of ["darwin", "win32"] as const) {
      const cap = detectSandboxCapability(BIN, probe({ platform: () => plat }));
      expect(cap.capable).toBe(true);
      expect(cap.reason).toContain(plat);
    }
  });

  it("a SUID-root helper makes the host capable regardless of userns", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({
        suidSandboxHelper: () => "/opt/chromium/chrome_sandbox",
        // userns fully locked down — helper still wins.
        readSysctlInt: (p) =>
          p.endsWith("max_user_namespaces")
            ? 0
            : p.endsWith("apparmor_restrict_unprivileged_userns")
              ? 1
              : null,
      }),
    );
    expect(cap.capable).toBe(true);
    expect(cap.reason).toContain("chrome_sandbox");
  });

  it("userns disabled (max_user_namespaces=0) is incapable", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({ readSysctlInt: (p) => (p.endsWith("max_user_namespaces") ? 0 : null) }),
    );
    expect(cap.capable).toBe(false);
    expect(cap.reason).toContain("max_user_namespaces=0");
  });

  it("Fedora shape (no AppArmor knob, userns nonzero) is capable", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({
        readSysctlInt: (p) =>
          p.endsWith("max_user_namespaces")
            ? 15000
            : /* apparmor knob absent */ null,
      }),
    );
    expect(cap.capable).toBe(true);
    expect(cap.reason).toContain("no AppArmor unprivileged-userns restriction");
  });

  it("AppArmor restriction ON with no covering profile is incapable", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({
        readSysctlInt: (p) =>
          p.endsWith("apparmor_restrict_unprivileged_userns") ? 1 : 20000,
        appArmorUsernsProfile: () => null,
      }),
    );
    expect(cap.capable).toBe(false);
    expect(cap.reason).toContain("no loaded profile grants 'userns'");
  });

  it("AppArmor restriction ON but a profile grants userns is capable", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({
        readSysctlInt: (p) =>
          p.endsWith("apparmor_restrict_unprivileged_userns") ? 1 : 20000,
        appArmorUsernsProfile: () => "lynceus-chromium",
      }),
    );
    expect(cap.capable).toBe(true);
    expect(cap.reason).toContain("lynceus-chromium");
  });

  it("AppArmor restriction explicitly OFF (=0) is capable", () => {
    const cap = detectSandboxCapability(
      BIN,
      probe({
        readSysctlInt: (p) =>
          p.endsWith("apparmor_restrict_unprivileged_userns") ? 0 : 20000,
      }),
    );
    expect(cap.capable).toBe(true);
    expect(cap.reason).toContain("apparmor_restrict_unprivileged_userns=0");
  });
});

describe("matchAppArmorPath", () => {
  it("matches an exact literal path", () => {
    expect(matchAppArmorPath("/opt/chromium/chrome", "/opt/chromium/chrome")).toBe(true);
    expect(matchAppArmorPath("/opt/chromium/chrome", "/opt/chromium/chromium")).toBe(false);
  });

  it("`*` does not cross a slash; `**` does", () => {
    expect(matchAppArmorPath("/opt/*/chrome", "/opt/chromium/chrome")).toBe(true);
    expect(matchAppArmorPath("/opt/*/chrome", "/opt/a/b/chrome")).toBe(false);
    expect(matchAppArmorPath("/opt/**/chrome", "/opt/a/b/chrome")).toBe(true);
  });

  it("supports `{a,b}` alternation", () => {
    const glob = "/opt/google/chrome/{chrome,chrome-sandbox}";
    expect(matchAppArmorPath(glob, "/opt/google/chrome/chrome")).toBe(true);
    expect(matchAppArmorPath(glob, "/opt/google/chrome/chrome-sandbox")).toBe(true);
    expect(matchAppArmorPath(glob, "/opt/google/chrome/other")).toBe(false);
  });

  it("treats regex metacharacters in the literal as literal", () => {
    expect(matchAppArmorPath("/a.b/chrome", "/a.b/chrome")).toBe(true);
    expect(matchAppArmorPath("/a.b/chrome", "/axb/chrome")).toBe(false);
  });
});

describe("parseAppArmorProfiles", () => {
  it("parses a named, path-attached profile and its body", () => {
    const text = [
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      "profile lynceus-chromium /opt/chromium/chrome flags=(unconfined) {",
      "  userns,",
      "  include if exists <local/lynceus-chromium>",
      "}",
    ].join("\n");
    const profs = parseAppArmorProfiles(text);
    expect(profs).toHaveLength(1);
    expect(profs[0]!.name).toBe("lynceus-chromium");
    expect(profs[0]!.attach).toBe("/opt/chromium/chrome");
    expect(profs[0]!.body).toContain("userns,");
  });

  it("parses an unnamed (path-only) profile, defaulting name to the path", () => {
    const text = "/usr/bin/chromium flags=(complain) {\n  network,\n}";
    const profs = parseAppArmorProfiles(text);
    expect(profs).toHaveLength(1);
    expect(profs[0]!.name).toBe("/usr/bin/chromium");
    expect(profs[0]!.attach).toBe("/usr/bin/chromium");
  });

  it("ignores named profiles with no filesystem attachment", () => {
    const text = "profile just_a_name {\n  userns,\n}";
    expect(parseAppArmorProfiles(text)).toHaveLength(0);
  });

  it("parses a multi-account profile whose glob ends in `}` (regression)", () => {
    // A real-world shape: brace-expanded home dirs AND a brace-expanded binary
    // name, so the attachment token ends in `}` right before ` flags=(...)`.
    // An earlier `\b` anchor dropped this profile — the false negative made a
    // sandbox-capable host default to `--no-sandbox`.
    const attach =
      "/home/{alice,bob}/.cache/ms-playwright/chromium*/chrome-linux/{chrome,headless_shell}";
    const text = [
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      `profile pw-chromium ${attach} flags=(unconfined) {`,
      "  userns,",
      "  include if exists <local/pw-chromium>",
      "}",
    ].join("\n");
    const profs = parseAppArmorProfiles(text);
    expect(profs).toHaveLength(1);
    expect(profs[0]!.name).toBe("pw-chromium");
    expect(profs[0]!.attach).toBe(attach);
    expect(profs[0]!.body).toContain("userns,");
    // ...and the glob resolves against a concrete resolved binary path.
    expect(
      matchAppArmorPath(
        profs[0]!.attach,
        "/home/alice/.cache/ms-playwright/chromium-1223/chrome-linux/chrome",
      ),
    ).toBe(true);
    expect(
      matchAppArmorPath(
        profs[0]!.attach,
        "/home/carol/.cache/ms-playwright/chromium-1/chrome-linux/chrome",
      ),
    ).toBe(false);
  });
});
