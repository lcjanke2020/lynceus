// L1 unit tests for the clearing-fill oracle.

import { describe, it, expect } from "vitest";
import { clearingFill } from "./clearing-fill.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

function base(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
  ];
}

describe("clearing-fill oracle", () => {
  it("passes when fill replaces the field to exactly the target value", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "fill", { selector: "#display-name", value: "Grace Hopper" }, { status: "filled", value_length: 12, tag: "input", count: 1 }),
      ...pair("4", "get_form_state", {}, { ok: true, fields: { "display-name": { kind: "field", value: "Grace Hopper" } }, missing: [] }),
    ];
    const out = clearingFill.oracle(trace, "The field now contains exactly: Grace Hopper.");
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("fails correctness when append-only type_text concatenates onto the old value", () => {
    // type_text without clear_first appends → "Old Draft NameGrace Hopper".
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "type_text", { selector: "#display-name", text: "Grace Hopper" }, { typed: 12, into: "#display-name" }),
      ...pair("4", "get_form_state", {}, { ok: true, fields: { "display-name": { kind: "field", value: "Old Draft NameGrace Hopper" } }, missing: [] }),
    ];
    const out = clearingFill.oracle(trace, "I typed Grace Hopper into the field.");
    expect(out.mechanic).toBe(0); // no fill used
    expect(out.correctness).toBe(0); // value not exact
    expect(out.notes).toMatch(/not exactly "Grace Hopper"|no successful fill/);
  });

  it("passes when the answer mentions the old value for context (regression: 2026-06-08 run trial 1)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "fill", { by: "label", label: "Display name", value: "Grace Hopper" }, { status: "filled", value_length: 12, tag: "input", count: 1 }),
      ...pair("4", "get_form_state", {}, { ok: true, fields: { "display-name": { kind: "field", value: "Grace Hopper" } }, missing: [] }),
    ];
    const answer = 'The "Display name" field now contains exactly Grace Hopper. The old value "Old Draft Name" was fully replaced.';
    const out = clearingFill.oracle(trace, answer);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("passes when the agent verifies without get_form_state — fill replace ⇒ exact by construction (regression: 2026-06-08 run trial 3)", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "fill", { by: "label", label: "Display name", value: "Grace Hopper" }, { status: "filled", value_length: 12, tag: "input", count: 1 }),
      // Verified via locate instead of get_form_state — no display-name read-back.
      ...pair("4", "locate", { by: "label", label: "Display name" }, { count: 1, elements: [{ value: "Grace Hopper" }] }),
    ];
    const out = clearingFill.oracle(trace, "Done — the field now holds exactly `Grace Hopper`.");
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
  });

  it("does not credit an evaluate-mutation solve", () => {
    const trace: TraceEntry[] = [
      ...base(),
      ...pair("3", "evaluate", { expression: "document.querySelector('#display-name').value='Grace Hopper'" }, { value: "Grace Hopper" }),
      ...pair("4", "get_form_state", {}, { ok: true, fields: { "display-name": { kind: "field", value: "Grace Hopper" } }, missing: [] }),
    ];
    const out = clearingFill.oracle(trace, "Field is now Grace Hopper.");
    expect(out.correctness).toBe(0);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/raw evaluate/);
  });
});
