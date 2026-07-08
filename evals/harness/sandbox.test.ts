// Unit tests for the eval-harness sandbox intent → decision folding
// (GH #41 / LEO-398). The capability probe is stubbed via a plain object, so
// these tests are host-independent.

import { describe, it, expect } from "vitest";
import {
  parseSandboxIntent,
  resolveSandboxDecision,
} from "./sandbox.js";
import type { SandboxCapability } from "../../src/util/browser-resolve.js";

const capable: SandboxCapability = { capable: true, reason: "userns available" };
const incapable: SandboxCapability = {
  capable: false,
  reason: "AppArmor restricts unprivileged user namespaces",
};

describe("parseSandboxIntent", () => {
  it("unset and 'auto' → auto", () => {
    expect(parseSandboxIntent(undefined)).toBe("auto");
    expect(parseSandboxIntent("")).toBe("auto");
    expect(parseSandboxIntent("  AUTO ")).toBe("auto");
  });

  it("truthy aliases → on (back-compat: true/1), case-insensitive", () => {
    for (const v of ["true", "1", "on", "ON"]) {
      expect(parseSandboxIntent(v)).toBe("on");
    }
  });

  it("falsy aliases → off", () => {
    for (const v of ["false", "0", "off", "OFF"]) {
      expect(parseSandboxIntent(v)).toBe("off");
    }
  });

  it("unrecognized values throw — no silent default (incl. yes/no, which are not aliases)", () => {
    for (const v of ["maybe", "yes", "no", "enabled"]) {
      expect(() => parseSandboxIntent(v)).toThrow(/EVAL_SANDBOX must be/);
    }
  });
});

describe("resolveSandboxDecision", () => {
  it("force-on + capable → enabled, source forced-on", () => {
    const d = resolveSandboxDecision("on", capable);
    expect(d).toMatchObject({ enabled: true, source: "forced-on" });
  });

  it("force-on + incapable → throws (fail fast, no downgrade)", () => {
    expect(() => resolveSandboxDecision("on", incapable)).toThrow(
      /EVAL_SANDBOX=on requested but this host has no usable/,
    );
  });

  it("force-off → disabled regardless of capability", () => {
    expect(resolveSandboxDecision("off", capable)).toMatchObject({
      enabled: false,
      source: "forced-off",
    });
    expect(resolveSandboxDecision("off", incapable).enabled).toBe(false);
  });

  it("auto + capable → enabled, source auto-capable", () => {
    const d = resolveSandboxDecision("auto", capable);
    expect(d).toMatchObject({ enabled: true, source: "auto-capable" });
    expect(d.reason).toBe(capable.reason);
  });

  it("auto + incapable → disabled with the capability reason (auto-fallback)", () => {
    const d = resolveSandboxDecision("auto", incapable);
    expect(d).toMatchObject({ enabled: false, source: "auto-fallback" });
    expect(d.reason).toBe(incapable.reason);
  });
});
