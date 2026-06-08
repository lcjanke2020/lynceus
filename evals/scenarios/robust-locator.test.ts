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
    expect(out.notes).toMatch(/did not verify a returned candidate/);
  });
});
