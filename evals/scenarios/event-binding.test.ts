import { describe, it, expect } from "vitest";
import { eventBinding } from "./event-binding.js";
import { pair } from "./_test-helpers.js";

describe("event-binding oracle", () => {
  it("passes when the agent waits ≤2 times, inspects DOM, and names the typo", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "set_breakpoint", { file: "main.ts", line: 7 }, { id: "bp" }),
      ...pair("4", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("5", "wait_for_pause", { timeout_ms: 2000 }, { error: "internal_error" }, true, "internal_error"),
      // Pivot: inspect the DOM/source
      ...pair("6", "query_selector", { selector: "#go" }, { found: true }),
      ...pair("7", "get_element_html", { selector: "#go" }, { html: "<button>...</button>" }),
      // Read the source — agent finds the typo
      ...pair("8", "list_scripts", {}, []),
    ];
    expect(
      eventBinding.oracle(
        trace,
        "main.ts line 7 has a typo: addEventListener('clik', ...) should be 'click'.",
      ).correctness,
    ).toBe(1);
  });

  it("fails mechanic when the agent retries wait_for_pause more than twice (didn't pivot)", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "set_breakpoint", { file: "main.ts", line: 7 }, { id: "bp" }),
      ...pair("4", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("5", "wait_for_pause", { timeout_ms: 2000 }, { error: "internal_error" }, true, "internal_error"),
      ...pair("6", "wait_for_pause", { timeout_ms: 2000 }, { error: "internal_error" }, true, "internal_error"),
      ...pair("7", "wait_for_pause", { timeout_ms: 2000 }, { error: "internal_error" }, true, "internal_error"),
      ...pair("8", "query_selector", { selector: "#go" }, { found: true }),
    ];
    const out = eventBinding.oracle(trace, "main.ts: missing listener 'clik'.");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/didn't pivot/);
  });

  it("fails when the answer doesn't name the typo or missing-listener kind", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "query_selector", { selector: "#go" }, { found: true }),
    ];
    expect(eventBinding.oracle(trace, "something is wrong in main.ts").correctness).toBe(0);
  });
});
