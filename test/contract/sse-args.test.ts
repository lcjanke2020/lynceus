// LEO-427: unit tests for the SSE security-gate decisions in src/index.ts.
// The startup refusal (--allow-remote), the loopback classification, and the
// skip-validation-on-non-loopback decision are the security posture README
// ("SSE caveats") and SECURITY.md advertise — none of it had a failing-path
// test. Also pins getKeepaliveMs parsing incl. the issue #3 fix (a
// whitespace-only env value must fall back to the default, not silently
// disable keepalive).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs, isLoopbackHost, buildSseGateConfig, getKeepaliveMs } from "../../src/index.js";

const ENV_VARS = [
  "LYNCEUS_ALLOW_REMOTE",
  "CDP_MCP_ALLOW_REMOTE",
  "LYNCEUS_SSE_KEEPALIVE_MS",
  "CDP_MCP_SSE_KEEPALIVE_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_VARS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_VARS) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("isLoopbackHost", () => {
  it("accepts the three canonical loopback aliases", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("treats everything else as non-loopback, including non-canonical loopback IPs", () => {
    // 127.0.0.2 IS loopback at the IP level, but the gate is deliberately
    // conservative: only the three canonical aliases skip --allow-remote.
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    // The bracketed URL form is not the bind-host spelling (`--host ::1`).
    expect(isLoopbackHost("[::1]")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("parseArgs", () => {
  it("defaults to stdio with no arguments", () => {
    expect(parseArgs([])).toEqual({ transport: "stdio" });
  });

  it("selects SSE on loopback with --port (space and = forms)", () => {
    const expected = { transport: "sse", host: "127.0.0.1", port: 9719, allowRemote: false };
    expect(parseArgs(["--port", "9719"])).toEqual(expected);
    expect(parseArgs(["--port=9719"])).toEqual(expected);
  });

  it("accepts ::1 as a loopback bind without --allow-remote", () => {
    expect(parseArgs(["--host", "::1", "--port", "9719"])).toEqual({
      transport: "sse",
      host: "::1",
      port: 9719,
      allowRemote: false,
    });
  });

  it("refuses a non-loopback bind without --allow-remote, naming the host", () => {
    expect(() => parseArgs(["--host", "0.0.0.0", "--port", "9719"])).toThrow(/--allow-remote/);
    expect(() => parseArgs(["--host", "0.0.0.0", "--port", "9719"])).toThrow(/0\.0\.0\.0/);
  });

  it("refuses non-canonical loopback IPs the same way (conservative gate)", () => {
    expect(() => parseArgs(["--host", "127.0.0.2", "--port", "9719"])).toThrow(/--allow-remote/);
  });

  it("allows a non-loopback bind with the --allow-remote flag", () => {
    expect(parseArgs(["--host", "0.0.0.0", "--port", "9719", "--allow-remote"])).toEqual({
      transport: "sse",
      host: "0.0.0.0",
      port: 9719,
      allowRemote: true,
    });
  });

  it("allows a non-loopback bind via LYNCEUS_ALLOW_REMOTE=1", () => {
    process.env.LYNCEUS_ALLOW_REMOTE = "1";
    expect(parseArgs(["--host", "0.0.0.0", "--port", "9719"])).toMatchObject({
      transport: "sse",
      allowRemote: true,
    });
  });

  it("allows a non-loopback bind via the deprecated CDP_MCP_ALLOW_REMOTE=1", () => {
    process.env.CDP_MCP_ALLOW_REMOTE = "1";
    expect(parseArgs(["--host", "0.0.0.0", "--port", "9719"])).toMatchObject({
      transport: "sse",
      allowRemote: true,
    });
  });

  it("stays in stdio mode when --host is given without --port (the gate is SSE-only)", () => {
    expect(parseArgs(["--host", "0.0.0.0"])).toEqual({ transport: "stdio" });
  });

  it("rejects missing and invalid --port values", () => {
    expect(() => parseArgs(["--port"])).toThrow(/--port requires a value/);
    expect(() => parseArgs(["--port", "abc"])).toThrow(/Invalid --port/);
    expect(() => parseArgs(["--port", "0"])).toThrow(/Invalid --port/);
    expect(() => parseArgs(["--port", "65536"])).toThrow(/Invalid --port/);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("buildSseGateConfig", () => {
  it("enables validation on a loopback bind with exactly the loopback alias allowlists", () => {
    const gate = buildSseGateConfig("127.0.0.1", 9719);
    expect(gate.validateHostOrigin).toBe(true);
    expect([...gate.allowedHosts].sort()).toEqual(["127.0.0.1:9719", "[::1]:9719", "localhost:9719"]);
    expect([...gate.allowedOrigins].sort()).toEqual([
      "http://127.0.0.1:9719",
      "http://[::1]:9719",
      "http://localhost:9719",
      "https://127.0.0.1:9719",
      "https://[::1]:9719",
      "https://localhost:9719",
    ]);
  });

  it("disables validation on a non-loopback bind (documented --allow-remote skip)", () => {
    const gate = buildSseGateConfig("0.0.0.0", 9719);
    expect(gate.validateHostOrigin).toBe(false);
    expect(gate.allowedHosts.size).toBe(0);
    expect(gate.allowedOrigins.size).toBe(0);
  });
});

describe("getKeepaliveMs (issue #3: whitespace must not disable keepalive)", () => {
  const DEFAULT = 25_000;

  it("returns the default when unset or empty", () => {
    expect(getKeepaliveMs()).toBe(DEFAULT);
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = "";
    expect(getKeepaliveMs()).toBe(DEFAULT);
  });

  it("returns the default for whitespace-only values instead of silently disabling", () => {
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = " ";
    expect(getKeepaliveMs()).toBe(DEFAULT);
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = "\t\n";
    expect(getKeepaliveMs()).toBe(DEFAULT);
  });

  it("disables only on an explicit 0", () => {
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = "0";
    expect(getKeepaliveMs()).toBe(0);
  });

  it("parses valid intervals, tolerating surrounding whitespace", () => {
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = "50";
    expect(getKeepaliveMs()).toBe(50);
    process.env.LYNCEUS_SSE_KEEPALIVE_MS = " 50 ";
    expect(getKeepaliveMs()).toBe(50);
  });

  it("falls back to the default on non-integer or negative values", () => {
    for (const bad of ["abc", "-5", "1.5"]) {
      process.env.LYNCEUS_SSE_KEEPALIVE_MS = bad;
      expect(getKeepaliveMs()).toBe(DEFAULT);
    }
  });
});
