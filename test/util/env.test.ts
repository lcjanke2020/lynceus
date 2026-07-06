// Unit tests for the LYNCEUS_* → CDP_MCP_* env-var fallback introduced with the
// cdp-mcp → lynceus rename. Each case uses a unique var-name pair so the
// module-level one-time-warn dedup in env.ts never leaks across cases.

import { describe, it, expect, vi, afterEach } from "vitest";
import { envWithFallback } from "../../src/util/env.js";

const touched: string[] = [];
function setEnv(name: string, value: string): void {
  process.env[name] = value;
  touched.push(name);
}

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
});

describe("envWithFallback", () => {
  it("returns the new var when it is set", () => {
    setEnv("LYNCEUS_ENVT_NEW", "new-value");
    expect(envWithFallback("LYNCEUS_ENVT_NEW", "CDP_MCP_ENVT_NEW")).toBe("new-value");
  });

  it("prefers the new var over the old and does not warn", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setEnv("LYNCEUS_ENVT_PREF", "new");
    setEnv("CDP_MCP_ENVT_PREF", "old");
    expect(envWithFallback("LYNCEUS_ENVT_PREF", "CDP_MCP_ENVT_PREF")).toBe("new");
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to the old var and writes a one-line deprecation note to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setEnv("CDP_MCP_ENVT_FALLBACK", "old-value");
    expect(envWithFallback("LYNCEUS_ENVT_FALLBACK", "CDP_MCP_ENVT_FALLBACK")).toBe("old-value");
    expect(spy).toHaveBeenCalledOnce();
    const note = String(spy.mock.calls[0]?.[0]);
    expect(note).toContain("CDP_MCP_ENVT_FALLBACK is deprecated");
    expect(note).toContain("LYNCEUS_ENVT_FALLBACK");
    expect(note.endsWith("\n")).toBe(true);
  });

  it("warns only once per deprecated var", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setEnv("CDP_MCP_ENVT_ONCE", "old");
    envWithFallback("LYNCEUS_ENVT_ONCE", "CDP_MCP_ENVT_ONCE");
    envWithFallback("LYNCEUS_ENVT_ONCE", "CDP_MCP_ENVT_ONCE");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("returns undefined when neither var is set", () => {
    expect(envWithFallback("LYNCEUS_ENVT_NONE", "CDP_MCP_ENVT_NONE")).toBeUndefined();
  });

  it("preserves an explicitly-empty new var without falling back", () => {
    setEnv("LYNCEUS_ENVT_EMPTY", "");
    setEnv("CDP_MCP_ENVT_EMPTY", "old");
    expect(envWithFallback("LYNCEUS_ENVT_EMPTY", "CDP_MCP_ENVT_EMPTY")).toBe("");
  });
});
