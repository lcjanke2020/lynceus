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
    ...pair("10", "get_cookies", { urls: ["http://x"] }, { cookies: [{ name: "session_token", domain: "127.0.0.1", path: "/", redacted: true, value_length: 6 }] }), // auth cookie back (value redacted)
    ...pair("11", "evaluate", { expression: "localStorage.getItem('user_pref')" }, { value: "dark" }), // user_pref back
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
    expect(out.notes).toMatch(/no genuine reset before restore/);
  });

  it("fails mechanic when close_session happens AFTER the restore (ordering — Copilot PR #17 r2)", () => {
    // Export → load → verify, THEN close + relaunch. Count-only (close happened +
    // ≥2 launches) would pass; ordering must not.
    const trace: TraceEntry[] = [
      ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("3", "set_cookies", { cookies: [{ name: "session_token", value: "s", url: "http://x" }] }, { set: 1 }),
      ...pair("4", "export_storage_state", { path: PATH }, { saved: PATH, cookies: 1, origins: 1 }),
      ...pair("5", "load_storage_state", { path: PATH }, { loaded: PATH, cookies: 1, origins_restored: ["http://x"], origins_skipped: [] }),
      ...pair("6", "evaluate", { expression: "localStorage.getItem('user_pref')" }, { value: "dark" }),
      ...pair("7", "close_session", {}, { closed: true }),
      ...pair("8", "launch_chrome", { headless: true }, { targetId: "T2" }),
    ];
    const out = sessionResume.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/no genuine reset before restore/);
  });

  it("fails correctness when the answer doesn't name the restored value", () => {
    const out = sessionResume.oracle(happyTrace(), "I exported and re-imported the session.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/did not affirm resume with user_pref=dark/);
  });

  it("fails mechanic on a cookie-only restore — no proof the localStorage half ran (regression: codex PR #17)", () => {
    const trace: TraceEntry[] = happyTrace().map((e) =>
      e.t === "tool_result" && e.tool === "load_storage_state"
        ? { ...e, output: { loaded: PATH, cookies: 1, origins_restored: [], origins_skipped: ["http://x"] } }
        : e,
    );
    const out = sessionResume.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/origins_restored empty/);
  });

  it("credits a correct run that ends with a courtesy close_session (regression: claude PR #17 r3)", () => {
    // RESUME_SYSTEM tells the agent to close_session when done, so the real run is
    // close → relaunch → load → verify → close(cleanup). The trailing close must
    // not invalidate the reset.
    const trace: TraceEntry[] = [...happyTrace(), ...pair("12", "close_session", {}, { closed: true })];
    const out = sessionResume.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when the cookie is not verified via get_cookies after load (regression: Copilot PR #17 r4)", () => {
    // All correct EXCEPT the post-load verification is an evaluate only — never
    // confirms (or exercises) the get_cookies / session_token round-trip.
    const trace: TraceEntry[] = [
      ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("3", "set_cookies", { cookies: [{ name: "session_token", value: "s", url: "http://x" }] }, { set: 1 }),
      ...pair("4", "export_storage_state", { path: PATH }, { saved: PATH, cookies: 1, origins: 1 }),
      ...pair("5", "close_session", {}, { closed: true }),
      ...pair("6", "launch_chrome", { headless: true }, { targetId: "T2" }),
      ...pair("7", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("8", "load_storage_state", { path: PATH }, { loaded: PATH, cookies: 1, origins_restored: ["http://x"], origins_skipped: [] }),
      ...pair("9", "evaluate", { expression: "localStorage.getItem('user_pref')" }, { value: "dark" }),
    ];
    const out = sessionResume.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/session_token cookie is back/);
  });

  it("is xfail-tagged (re-hedged after PR #17 tightened the localStorage-restore check)", () => {
    expect(sessionResume.xfailCorrectness).toBe(true);
  });
});
