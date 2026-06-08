// L1 unit tests for the robust-locator oracle.

import { describe, it, expect } from "vitest";
import { robustLocator } from "./robust-locator.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

const SUGGEST_OUT = {
  candidates: [
    { locator: { by: "role", role: "button", name: "Go" }, match_count: 1, unambiguous: true, resolves_to_target: true },
    { locator: { by: "text", text: "Go" }, match_count: 1, unambiguous: true, resolves_to_target: true },
    { locator: { by: "css", css: "#go" }, match_count: 1, unambiguous: true, resolves_to_target: true },
  ],
  recommended: 0,
};

function base(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
  ];
}

describe("robust-locator oracle", () => {
  it("passes when suggest_locator is called, a candidate is verified, and an unambiguous one is reported", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "role", role: "button", name: "Go" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, 'The most robust locator is role=button name="Go" — it matches exactly one element.');
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("accepts the text candidate too (does not force by:role)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "text", text: "Go" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, 'I chose the text locator getByText("Go"); it is unambiguous (1 match).');
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when suggest_locator is never called", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "query_selector", { selector: "#go" }, { node_id: 5 }),
    ];
    const out = robustLocator.oracle(trace, "Use the CSS selector #go.");
    expect(out.mechanic).toBe(0);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/never called suggest_locator/);
  });

  it("fails mechanic when no candidate is verified via locate", () => {
    const trace: TraceEntry[] = [...base(), ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT)];
    const out = robustLocator.oracle(trace, 'role=button name="Go"');
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/did not verify a SEMANTIC candidate/);
  });

  it("fails mechanic when the verifying locate resolves to more than one element (regression: codex PR #17)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "role", role: "button", name: "Go" }, { count: 2, elements: [{}, {}] }),
    ];
    const out = robustLocator.oracle(trace, 'role=button name="Go"');
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/exactly one element/);
  });

  it("accepts wait_for verification reading the nested result.count (regression: codex PR #17 r2)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "wait_for", { by: "role", role: "button", name: "Go" }, { state: "visible", elapsed_ms: 5, locator: {}, result: { count: 1, visible_count: 1 } }),
    ];
    const out = robustLocator.oracle(trace, 'role=button name="Go" — exactly one match.');
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("does not credit verifying/reporting only the brittle CSS fallback #go (regression: Copilot PR #17 r4)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "css", css: "#go" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, "The most robust locator is the CSS selector #go.");
    expect(out.mechanic).toBe(0); // only verified the css fallback, not a semantic locator
    expect(out.correctness).toBe(0);
  });

  it("does not credit validating a semantic locator but REPORTING the css selector #go (regression: claude PR #17 r5)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "role", role: "button", name: "Go" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, "I validated the button, but I'll just use the CSS selector #go.");
    expect(out.mechanic).toBe(1); // it did validate a semantic candidate
    expect(out.correctness).toBe(0); // but it settled on / reported the css selector
  });

  it("matches a test_id candidate verified via the camelCase testId alias (regression: Copilot PR #17 r3)", () => {
    const suggest = {
      candidates: [{ locator: { by: "test_id", test_id: "go-btn" }, match_count: 1, unambiguous: true, resolves_to_target: true }],
      recommended: 0,
    };
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, suggest),
      ...pair("4", "locate", { by: "test_id", testId: "go-btn" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, 'I used the test id "go-btn" — exactly one match.');
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("does not credit an answer that names no accessible name — 'use a role locator' (regression: Copilot PR #17 r2)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "suggest_locator", { selector: "#go" }, SUGGEST_OUT),
      ...pair("4", "locate", { by: "role", role: "button", name: "Go" }, { count: 1, elements: [{}] }),
    ];
    const out = robustLocator.oracle(trace, "I would just use a role locator here.");
    expect(out.mechanic).toBe(1); // it did suggest + verify a 1-match candidate
    expect(out.correctness).toBe(0); // but the answer named no unambiguous candidate
  });
});
