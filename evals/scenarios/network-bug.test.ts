import { describe, it, expect } from "vitest";
import { networkBug } from "./network-bug.js";
import { pair } from "./_test-helpers.js";

describe("network-bug oracle", () => {
  it("passes when the agent clicked, inspected network, named the 404", () => {
    const trace = [
      ...pair("1", "attach_chrome", {}, { targetId: "T1" }),
      ...pair("2", "navigate", { url: "x" }, { url: "x" }),
      ...pair("3", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("4", "get_network_requests", {}, {
        items: [
          { url: "http://x/api/wrong-endpoint", status: 404, type: "Fetch", finished: true },
        ],
      }),
    ];
    expect(
      networkBug.oracle(trace, "The fetch to /api/wrong-endpoint returns 404.")
        .correctness,
    ).toBe(1);
  });

  it("passes when the agent names the wrong URL even without the 404 number", () => {
    const trace = [
      ...pair("1", "click", { selector: "#go" }, { clicked: "#go" }),
      ...pair("2", "get_network_requests", {}, { items: [] }),
    ];
    expect(
      networkBug.oracle(trace, "The URL /api/wrong-endpoint is wrong — should probably be /api/right-endpoint.")
        .correctness,
    ).toBe(1);
  });

  it("fails mechanic when get_network_requests was never called", () => {
    const trace = [
      ...pair("1", "click", { selector: "#go" }, { clicked: "#go" }),
    ];
    const out = networkBug.oracle(trace, "404 on /api/wrong-endpoint");
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
  });
});
