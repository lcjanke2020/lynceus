// L1 unit tests for the idempotent-toggle oracle.

import { describe, it, expect } from "vitest";
import { idempotentToggle } from "./idempotent-toggle.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

const END_STATE = {
  ok: true,
  fields: {
    subscribe: { kind: "field", value: true },
    beta: { kind: "field", value: false },
    plan: { kind: "radio_group", value: "pro" },
  },
  missing: [],
};

function base(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
  ];
}

const GOOD_ANSWER = "Final state: Email updates = ON, Beta features = OFF, plan = Pro.";

describe("idempotent-toggle oracle", () => {
  it("passes on idempotent check + uncheck + radio check, no blind clicks", () => {
    const trace: TraceEntry[] = [
      ...base(),
      // subscribe already on → check returns already-checked
      ...pair("3", "check", { selector: "#subscribe" }, { status: "already-checked", checked: true, count: 1 }),
      // beta on → uncheck turns it off
      ...pair("4", "uncheck", { selector: "#beta" }, { status: "unchecked", checked: false, count: 1 }),
      // pro radio off → check turns it on
      ...pair("5", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
      ...pair("6", "get_form_state", {}, END_STATE),
    ];
    const out = idempotentToggle.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when the agent blindly clicks the already-on checkbox", () => {
    // A click on the on checkbox toggles it OFF — the trap. End state wrong too.
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "click", { selector: "#subscribe" }, { clicked: "#subscribe" }),
      ...pair("4", "uncheck", { selector: "#beta" }, { status: "unchecked", checked: false, count: 1 }),
      ...pair("5", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
      ...pair("6", "get_form_state", {}, { ok: true, fields: { subscribe: { value: false }, beta: { value: false }, plan: { value: "pro" } }, missing: [] }),
    ];
    const out = idempotentToggle.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/blind click|idempotent check/);
  });

  it("fails correctness when the answer names the fields but not their on/off states (regression: Copilot PR #17 r5)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "check", { selector: "#subscribe" }, { status: "already-checked", checked: true, count: 1 }),
      ...pair("4", "uncheck", { selector: "#beta" }, { status: "unchecked", checked: false, count: 1 }),
      ...pair("5", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
      ...pair("6", "get_form_state", {}, END_STATE),
    ];
    const out = idempotentToggle.oracle(trace, "I set Email updates, Beta features, and the Pro plan.");
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/names \+ on\/off/);
  });

  it("requires get_form_state for correctness — status fallback removed (regression: Copilot PR #17 r5)", () => {
    // Mechanically plausible, but the agent unchecked the wrong box (Email, not
    // Beta) and never read the form back. Statuses carry no locator, so without
    // the read-back this must not pass.
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "check", { selector: "#subscribe" }, { status: "already-checked", checked: true, count: 1 }),
      ...pair("4", "uncheck", { selector: "#subscribe" }, { status: "unchecked", checked: false, count: 1 }),
      ...pair("5", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
    ];
    const out = idempotentToggle.oracle(trace, "Email updates ON, Beta OFF, Pro selected.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/read-back missing/);
  });

  it("credits a correct run whose answer reports states as yes/no (offish/onish symmetry — claude PR #17 r6)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "check", { selector: "#subscribe" }, { status: "already-checked", checked: true, count: 1 }),
      ...pair("4", "uncheck", { selector: "#beta" }, { status: "unchecked", checked: false, count: 1 }),
      ...pair("5", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
      ...pair("6", "get_form_state", {}, END_STATE),
    ];
    // End state is correct; the answer reports it as yes/no rather than on/off.
    const out = idempotentToggle.oracle(trace, "Email updates: yes, Beta features: no, plan: Pro.");
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when uncheck is never used (beta left on)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "check", { selector: "#subscribe" }, { status: "already-checked", checked: true, count: 1 }),
      ...pair("4", "check", { role: "radio", name: "Pro" }, { status: "checked", checked: true, count: 1 }),
      ...pair("5", "get_form_state", {}, { ok: true, fields: { subscribe: { value: true }, beta: { value: true }, plan: { value: "pro" } }, missing: [] }),
    ];
    const out = idempotentToggle.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/Beta not turned off via uncheck/);
  });
});
