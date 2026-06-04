import { describe, it, expect } from "vitest";
import { consoleError } from "./console-error.js";
import { pair } from "./_test-helpers.js";

describe("console-error oracle", () => {
  it("passes when the agent clicked, pulled console, and named the error+source", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("4", "get_console_logs", { level: "error" }, {
        items: [
          {
            level: "error",
            text: "TypeError: Cannot read properties of null (reading 'value')",
            file: "main.ts",
            line: 14,
          },
        ],
      }),
    ];
    expect(
      consoleError.oracle(
        trace,
        "main.ts: TypeError — trying to read .value on null.",
      ).correctness,
    ).toBe(1);
  });

  it("fails mechanic when no click happened (error never triggered)", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "get_console_logs", {}, { items: [] }),
    ];
    const out = consoleError.oracle(trace, "main.ts has a TypeError.");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });

  it("fails mechanic when get_console_logs was never called", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "click", { selector: "#go" }, { clicked: "#go" }),
    ];
    const out = consoleError.oracle(trace, "main.ts: TypeError on null.");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });
});
