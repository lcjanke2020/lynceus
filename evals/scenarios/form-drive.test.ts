// L1 unit tests for the form-drive oracle. Pure (trace, finalAnswer) →
// OracleResult; synthetic traces, no LLM/browser.

import { describe, it, expect } from "vitest";
import { formDrive } from "./form-drive.js";
import { pair } from "./_test-helpers.js";
import type { TraceEntry } from "../harness/types.js";

const FORM_STATE = {
  ok: true,
  fields: {
    fruit: { kind: "field", value: "banana" },
    subscribe: { kind: "field", value: true },
    "fruits-multi": { kind: "field", value: ["apple", "cherry"] },
  },
  missing: [],
};

function happyTrace(): TraceEntry[] {
  return [
    ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
    ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
    ...pair("3", "fill", { selector: "#name-input", value: "Ada Lovelace" }, { status: "filled", value_length: 12, tag: "input", count: 1 }),
    ...pair("4", "select_option", { selector: "#fruit", option_label: "Banana" }, { status: "selected", selected: [{ value: "banana", label: "Banana", index: 1 }], multiple: false, count: 1 }),
    ...pair("5", "check", { selector: "#subscribe" }, { status: "checked", checked: true, count: 1 }),
    ...pair("6", "select_option", { selector: "#fruits-multi", option_index: [0, 2], multiple: true }, { status: "selected", selected: [{ value: "apple", label: "Apple", index: 0 }, { value: "cherry", label: "Cherry", index: 2 }], multiple: true, count: 1 }),
    ...pair("7", "get_form_state", {}, FORM_STATE),
  ];
}

const GOOD_ANSWER = "Done: name = Ada Lovelace, fruit = Banana, Subscribe is checked (on), favourites = Apple and Cherry.";

describe("form-drive oracle", () => {
  it("passes when each control is driven with the right tool and read-back matches", () => {
    const out = formDrive.oracle(happyTrace(), GOOD_ANSWER);
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("fails mechanic when the single select is driven with type_text", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("3", "fill", { selector: "#name-input", value: "Ada Lovelace" }, { status: "filled", value_length: 12, tag: "input", count: 1 }),
      ...pair("4", "type_text", { selector: "#fruit", text: "Banana" }, { typed: 6, into: "#fruit" }),
      ...pair("5", "check", { selector: "#subscribe" }, { status: "checked", checked: true, count: 1 }),
      ...pair("6", "select_option", { selector: "#fruits-multi", option_index: [0, 2], multiple: true }, { status: "selected", selected: [{ value: "apple", index: 0 }, { value: "cherry", index: 2 }], multiple: true, count: 1 }),
      ...pair("7", "get_form_state", {}, { ok: true, fields: { fruit: { value: "apple" }, subscribe: { value: true }, "fruits-multi": { value: ["apple", "cherry"] } }, missing: [] }),
    ];
    const out = formDrive.oracle(trace, GOOD_ANSWER);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/type_text on a <select>|fruit=banana/);
  });

  it("does not credit correctness for an evaluate-mutation solve even if the end state is right", () => {
    const trace: TraceEntry[] = [
      ...pair("1", "launch_chrome", { headless: true }, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "http://x" }, { url: "http://x" }),
      ...pair("3", "evaluate", { expression: "document.querySelector('#fruit').value='banana'; document.querySelector('#subscribe').checked=true" }, { value: null }),
      ...pair("4", "get_form_state", {}, FORM_STATE),
    ];
    const out = formDrive.oracle(trace, GOOD_ANSWER);
    expect(out.correctness).toBe(0);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/raw evaluate/);
  });

  it("fails correctness when the final answer omits fields", () => {
    const out = formDrive.oracle(happyTrace(), "I set the fruit to banana.");
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/did not report all field values/);
  });
});
