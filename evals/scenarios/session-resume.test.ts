// L1 unit tests for the session-resume oracle.

import { describe, it, expect } from "vitest";
import { sessionResume } from "./session-resume.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

const PATH = "/tmp/cdp-mcp-eval-session.json";

function happyTrace(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }), // launch #1
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
    ...pair("3", "set_cookies", { cookies: [{ name: "session_token", value: "s3cr3t", url: "http://x" }] }, { set: 1 }),
    ...pair("4", "export_storage_state", { path: PATH }, { saved: PATH, cookies: 1, origins: 1 }),
    ...pair("5", "close_session", {}, { closed: true }),
    ...pair("6", "launch_chrome", { headless: true }, { targetId: "T2" }), // launch #2 — fresh
    ...pair("7", "navigate", { url: "http://x" }, { url: "http://x" }),
    ...pair("8", "get_cookies", { urls: ["http://x"] }, { cookies: [] }), // confirm gone
    ...pair("9", "load_storage_state", { path: PATH }, { loaded: PATH, cookies: 1, origins_restored: ["http://x"], origins_skipped: [] }),
    ...pair("10", "evaluate", { expression: "localStorage.getItem('user_pref')" }, { value: "dark" }), // verify after load
  ];
}

const GOOD_ANSWER = 'Resume succeeded — after restoring into the fresh browser, the session_token cookie and user_pref are back. user_pref = "dark".';

describe("session-resume oracle", () => {
  it("passes the full seed → export → fresh browser → restore → verify cycle", () => {
    const out = sessionResume.oracle(happyTrace(), GOOD_ANSWER);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when there is no genuine reset (no close + relaunch)", () => {
    // Agent exports, then loads in the SAME session without close/relaunch — the
    // "verified without resetting" false-pass the oracle guards against.
    const trace: TraceEntry[] = [
      ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("3", "set_cookies", { cookies: [{ name: "session_token", value: "s", url: "http://x" }] }, { set: 1 }),
      ...pair("4", "export_storage_state", { path: PATH }, { saved: PATH, cookies: 1, origins: 1 }),
      ...pair("5", "load_storage_state", { path: PATH }, { loaded: PATH, cookies: 1, origins_restored: ["http://x"], origins_skipped: [] }),
      ...pair("6", "evaluate", { expression: "localStorage.getItem('user_pref')" }, { value: "dark" }),
    ];
    const out = sessionResume.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no genuine fresh session/);
  });

  it("fails correctness when the answer doesn't name the restored value", () => {
    const out = sessionResume.oracle(happyTrace(), "I exported and re-imported the session.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/did not affirm resume with user_pref=dark/);
  });

  it("is tagged xfailCorrectness initially", () => {
    expect(sessionResume.xfailCorrectness).toBe(true);
  });
});
