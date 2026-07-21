import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../harness/types.js";
import { pair } from "./_test-helpers.js";
import { fullstackCart } from "./fullstack-cart.js";

function successfulTrace(): TraceEntry[] {
  return [
    ...pair(
      "1",
      "launch_node",
      {
        script: "examples/sample-fullstack-app/server/dist/index.js",
        label: "backend",
      },
      { session: "node_1", label: "backend" },
    ),
    ...pair(
      "2",
      "set_breakpoint",
      { session: "node_1", file: "server/src/cart.ts", line: 24 },
      {
        id: "bp_1",
        binding_count: 1,
        resolved_locations: [{ file: "server/src/cart.ts", line: 24 }],
      },
    ),
    ...pair(
      "3",
      "launch_chrome",
      { url: "http://127.0.0.1:5173", label: "frontend" },
      { session: "browser_1", label: "frontend" },
    ),
    ...pair(
      "4",
      "list_sessions",
      {},
      {
        sessions: [
          { session: "node_1", kind: "node", label: "backend" },
          { session: "browser_1", kind: "browser", label: "frontend" },
        ],
      },
    ),
    ...pair(
      "5",
      "set_breakpoint",
      { session: "browser_1", file: "src/CartButton.tsx", line: 15 },
      {
        // Same text as the Node bp is intentional: breakpoint ids are scoped
        // to the debug-target session and must not be compared globally.
        id: "bp_1",
        binding_count: 1,
        resolved_locations: [{ file: "src/CartButton.tsx", line: 15 }],
      },
    ),
    ...pair(
      "6",
      "wait_for_pause",
      { session: "node_1" },
      {
        hit_breakpoint_ids: ["bp_1"],
        call_stack: [{ file: "server/src/cart.ts", line: 24 }],
      },
    ),
  ];
}

describe("fullstack-cart oracle", () => {
  it("passes the structural mechanic with concurrent kinds, per-session bindings, and a Node cart pause", () => {
    const out = fullstackCart.oracle(
      successfulTrace(),
      "server/src/index.ts:25 registers express.json() after cartRouter, so req.body is undefined in cart.ts:24.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("grades the final successful browser and Node sessions after relaunch recovery", () => {
    const trace: TraceEntry[] = [
      ...pair(
        "stale-node-launch",
        "launch_node",
        { script: "server/dist/index.js", label: "backend-stale" },
        { session: "node_stale", label: "backend-stale" },
      ),
      ...pair(
        "stale-browser-launch",
        "launch_chrome",
        { url: "http://127.0.0.1:5173", label: "frontend-stale" },
        { session: "browser_stale", label: "frontend-stale" },
      ),
      ...pair(
        "stale-node-close",
        "close_session",
        { session: "node_stale" },
        { closed: true },
      ),
      ...pair(
        "stale-browser-close",
        "close_session",
        { session: "browser_stale" },
        { closed: true },
      ),
      ...successfulTrace(),
    ];

    const out = fullstackCart.oracle(
      trace,
      "server/src/index.ts registers express.json() after cartRouter, so req.body is undefined in cart.ts:24.",
    );

    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(1);
    expect(out.notes).toMatch(/solved/);
  });

  it("accepts a precise unparsed req.body diagnosis", () => {
    const out = fullstackCart.oracle(
      successfulTrace(),
      "cart.ts:24 sees req.body as undefined because the request body was never parsed.",
    );
    expect(out.correctness).toBe(1);
  });

  it("fails mechanic when list_sessions never proves both targets were live together", () => {
    const trace = successfulTrace().filter(
      (entry) => !("tool" in entry && entry.tool === "list_sessions"),
    );
    const out = fullstackCart.oracle(
      trace,
      "index.ts registers express.json after the router.",
    );
    expect(out.correctness).toBe(1);
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/live together/);
  });

  it("fails mechanic when the frontend breakpoint did not actually bind", () => {
    const trace = successfulTrace().map((entry) => {
      if (
        entry.t === "tool_result" &&
        entry.toolUseId === "5"
      ) {
        return { ...entry, output: { id: "bp_1", binding_count: 0, resolved_locations: [] } };
      }
      return entry;
    });
    const out = fullstackCart.oracle(
      trace,
      "index.ts registers express.json after the router.",
    );
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/CartButton\.tsx/);
  });

  it("does not let a same-string browser breakpoint id satisfy the Node pause", () => {
    const trace = successfulTrace().map((entry) => {
      if (entry.t === "tool_call" && entry.toolUseId === "6") {
        return { ...entry, input: { session: "browser_1" } };
      }
      return entry;
    });
    const out = fullstackCart.oracle(
      trace,
      "index.ts registers express.json after the router.",
    );
    expect(out.mechanic).toBe(0);
    expect(out.notes).toMatch(/Node-scoped pause/);
  });

  it("requires the Node pause stack to be in cart.ts", () => {
    const trace = successfulTrace().map((entry) => {
      if (entry.t === "tool_result" && entry.toolUseId === "6") {
        return {
          ...entry,
          output: {
            hit_breakpoint_ids: ["bp_1"],
            call_stack: [{ file: "src/CartButton.tsx", line: 15 }],
          },
        };
      }
      return entry;
    });
    expect(
      fullstackCart.oracle(
        trace,
        "index.ts registers express.json after the router.",
      ).mechanic,
    ).toBe(0);
  });

  it("keeps correctness independent from a successful debugger mechanic", () => {
    const out = fullstackCart.oracle(
      successfulTrace(),
      "The cart stays empty; investigate the backend further.",
    );
    expect(out.mechanic).toBe(1);
    expect(out.correctness).toBe(0);
    expect(out.notes).toMatch(/late JSON middleware|unparsed req\.body/);
  });

  it("starts both axes xfailed and uses the explicit dual target", () => {
    expect(fullstackCart.xfailCorrectness).toBe(true);
    expect(fullstackCart.xfailMechanic).toBe(true);
    expect(fullstackCart.target).toEqual({
      kind: "dual",
      webAppDir: "examples/sample-fullstack-app",
      webUrl: "http://127.0.0.1:5173",
      script: "examples/sample-fullstack-app/server/dist/index.js",
    });
  });
});
