// L1 unit tests for the cookie-redaction oracle.

import { describe, it, expect } from "vitest";
import { cookieRedaction } from "./cookie-redaction.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

// get_cookies redacts the session_token value (name matches the sensitive
// regex) and shows theme's value.
const GET_COOKIES_OUT = {
  cookies: [
    { name: "session_token", domain: "127.0.0.1", path: "/", redacted: true, value_length: 12, httpOnly: false },
    { name: "theme", domain: "127.0.0.1", path: "/", redacted: false, value: "dark", value_length: 4, httpOnly: false },
  ],
};

function base(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
    ...pair("3", "set_cookies", { cookies: [{ name: "session_token", value: "abc123secret", url: "http://x" }, { name: "theme", value: "dark", url: "http://x" }] }, { set: 2 }),
  ];
}

describe("cookie-redaction oracle", () => {
  it("passes when both cookies are set, listed, and correctly classified", () => {
    const trace: TraceEntry[] = [...base(), ...pair("4", "get_cookies", { urls: ["http://x"] }, GET_COOKIES_OUT)];
    const answer =
      "session_token's value was redacted (its name matches the session/auth pattern), so it is NOT safe to print. theme's value (dark) is shown and is safe to log.";
    const out = cookieRedaction.oracle(trace, answer);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails correctness when the classification is wrong", () => {
    const trace: TraceEntry[] = [...base(), ...pair("4", "get_cookies", { urls: ["http://x"] }, GET_COOKIES_OUT)];
    const out = cookieRedaction.oracle(trace, "Both cookies look fine and are safe to print.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/did not correctly classify/);
  });

  it("fails mechanic when get_cookies was never called", () => {
    const out = cookieRedaction.oracle(base(), "session_token is redacted; theme is safe.");
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/get_cookies did not return both cookies/);
  });
});
