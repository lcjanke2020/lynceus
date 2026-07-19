// L3 launch_node e2e: lynceus owns the Node child, parses the inspector
// endpoint from stderr, attaches through the shared Node Inspector path, and
// close_session terminates the launched process.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { buildToolMap, call } from "./helpers/build-tools.js";

const tools = buildToolMap();

const FIXTURE_ENTRY = join(
  process.cwd(),
  "examples",
  "sample-node-app",
  "dist",
  "index.js",
);

describe("node launch flow (e2e)", () => {
  it("launch_node → entry pause → TS breakpoint → resume → bp hit → close", async () => {
    const launched = await call<{
      targetId: string;
      url: string;
      pid: number;
      port: number;
      inspectMode: string;
      cwd: string;
      script: string;
    }>(tools, "launch_node", { script: FIXTURE_ENTRY });

    expect(launched.targetId).toBeTruthy();
    expect(launched.url).toMatch(/^file:\/\/.*\/sample-node-app\/dist\/index\.js$/);
    expect(launched.pid).toBeGreaterThan(0);
    expect(launched.port).toBeGreaterThan(0);
    expect(launched.inspectMode).toBe("inspect-brk");
    expect(launched.script).toBe(FIXTURE_ENTRY);

    const entryPause = await call<{
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(entryPause.hit_breakpoint_ids).toEqual([]);
    // The entry-pause frame's exact module (index.ts vs handlers.ts) is a
    // V8/Node-version-dependent detail — like the entry-pause `reason` we
    // deliberately don't assert. Require only that it resolved to a TS frame,
    // which is the load-bearing check: source-map mapping worked at entry (an
    // unmapped frame would surface as the raw dist/*.js path).
    expect(entryPause.call_stack[0]!.file).toMatch(/\.ts$/);

    const bp = await call<{
      id: string;
      status: string;
      binding_count: number;
      resolved_locations: Array<{ file: string; line: number; column: number }>;
    }>(tools, "set_breakpoint", { file: "handlers.ts", line: 2 });
    expect(bp.status).toBe("set");
    expect(bp.binding_count).toBeGreaterThanOrEqual(1);
    expect(bp.resolved_locations[0]!.file).toMatch(/handlers\.ts$/);

    expect(await call<string>(tools, "resume")).toBe("resumed");

    const bpHit = await call<{
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(bpHit.hit_breakpoint_ids).toContain(bp.id);
    expect(bpHit.call_stack[0]!.file).toMatch(/handlers\.ts$/);
    expect(bpHit.call_stack[0]!.line).toBe(2);

    expect((await call<{ status: string }>(tools, "close_session")).status).toBe("closed");
  });
});
