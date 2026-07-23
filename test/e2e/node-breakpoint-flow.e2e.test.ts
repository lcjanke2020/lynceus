// L3 Node-Inspector e2e: spawn a real node --inspect-brk against a tsc-
// compiled fixture (examples/sample-node-app/), drive the canonical
// attach → entry-pause → TS breakpoint → resume → breakpoint-hit → close
// flow through the MCP tool surface, and verify the source-map round trip
// landed the pause on the right TS line.
//
// The fixture is intentionally tiny (one ESM import, one exported greet
// function), compiled to disk by tsc so this spec's source-map round trip
// has real .js + .js.map files to resolve.
//
// What this test does NOT assert (deliberate):
//   - The exact `reason` string on the entry pause. V8 emits values
//     outside the Chromium devtools-protocol union ("Break on start"
//     observed empirically on Node v24.13.1). Implementers must drive
//     off hit_breakpoint_ids / hitBreakpoints, never reason equality.
//   - The exact `reason` string on the breakpoint hit. Same rationale.
//   - The exact module the entry pause lands in. V8 picks where; empirically
//     (Node v24.13.1) it's the first executable line of the first-evaluated
//     ESM module — for `index.ts → import "./handlers.js"` that's
//     handlers.ts, not index.ts. The /handlers\.ts$/ assertion below is a
//     concession to that empirical behavior, not a contract.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildToolMap,
  call,
  callExpectError,
} from "./helpers/build-tools.js";
import {
  spawnInspectorTarget,
  type InspectorTarget,
} from "./helpers/node-target.js";

const tools = buildToolMap();

describe("node breakpoint flow (e2e)", () => {
  let target: InspectorTarget | null = null;

  beforeEach(async () => {
    target = await spawnInspectorTarget();
  });

  afterEach(() => {
    // The session is closed by the shared afterEach in setup/after-each.ts
    // (kind-agnostic via SessionState.close()), but the spawned Node child
    // is NOT in the session's ownedProcess (attach mode — attach_node sets
    // attached=true, ownedProcess=null). We have to kill it ourselves.
    target?.kill();
    target = null;
  });

  it("attach_node → entry pause → set_breakpoint(handlers.ts:2) → resume → bp hit → close", async () => {
    const { port } = target!;

    // Step 1 — attach_node. Returns the inspector target and its file:// url.
    const attached = await call<{ targetId: string; url: string }>(
      tools,
      "attach_node",
      { port },
    );
    expect(attached.targetId).toBeTruthy();
    // Node's inspector exposes the entry script as a file:// URL — confirmed
    // empirically on Node v24.13.1.
    expect(attached.url).toMatch(/^file:\/\/.*\/sample-node-app\/dist\/index\.js$/);

    // Step 2 — wait_for_pause picks up the entry pause that V8 fires after
    // Runtime.runIfWaitingForDebugger (issued inside attach_node). The
    // reason is intentionally not asserted (see file-level comment).
    //
    // The entry-pause frame IS asserted to be TS-mapped: summarizePause /
    // formatFrameForPause were given a bounded wait for the source-
    // map consumer (mirroring mapOriginalToGenerated's existing wait used
    // by set_breakpoint), so the entry-pause frame.file now resolves to
    // the TS path even though Debugger.scriptParsed → loadSourceMap is
    // fire-and-forget. (Before that fix this assertion would have flaked on
    // the raw file:// URL.)
    const entryPause = await call<{
      reason: string;
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(entryPause.hit_breakpoint_ids).toEqual([]);
    expect(entryPause.call_stack.length).toBeGreaterThan(0);
    // TS-mapped is the contract (above); the exact module is a V8-version
    // detail, so match any .ts frame rather than pinning handlers.ts.
    expect(entryPause.call_stack[0]!.file).toMatch(/\.ts$/);

    // Step 3 — set_breakpoint on handlers.ts:2 (the `const msg = ...`
    // assignment). Static ESM import means handlers.js is already in
    // ScriptStore by the time the entry pause fires, so the binding
    // resolves cleanly.
    const bp = await call<{
      id: string;
      status: string;
      binding_count: number;
      resolved_locations: Array<{ file: string; line: number; column: number }>;
    }>(tools, "set_breakpoint", { file: "handlers.ts", line: 2 });
    expect(bp.status).toBe("set");
    expect(bp.binding_count).toBeGreaterThanOrEqual(1);
    expect(bp.resolved_locations.length).toBeGreaterThan(0);
    expect(bp.resolved_locations[0]!.file).toMatch(/handlers\.ts$/);
    expect(bp.resolved_locations[0]!.line).toBe(2);

    // Step 4 — resume. Returns the plain string "resumed" (the resume tool's
    // documented envelope — see registerExecutionTools in src/tools/
    // execution.ts).
    const resumed = await call<string>(tools, "resume");
    expect(resumed).toBe("resumed");

    // Step 5 — wait_for_pause for the breakpoint hit. index.ts's static
    // greet("world") call drives execution into handlers.ts immediately
    // after resume, so the hit lands promptly. No sleep needed: `resume`
    // blocks on Debugger.resumed before returning, so
    // PauseTracker.state is guaranteed cleared when this wait_for_pause
    // starts.
    const bpHit = await call<{
      reason: string;
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(bpHit.hit_breakpoint_ids).toContain(bp.id);
    expect(bpHit.call_stack[0]!.file).toMatch(/handlers\.ts$/);
    expect(bpHit.call_stack[0]!.line).toBe(2);

    // Step 6 — close_session. The shared afterEach would also handle this,
    // but invoking it here exercises the explicit-close path directly. After
    // close the spawned Node child stays alive (attach mode) — afterEach
    // kills it.
    await call(tools, "close_session");
  });

  it("set_breakpoint on a non-existent line returns no_mapping", async () => {
    const { port } = target!;
    await call(tools, "attach_node", { port });
    // The entry pause has to be drained before set_breakpoint can run —
    // mapOriginalToGenerated requires the script's source-map consumer to
    // be in ScriptStore, which lands on (or shortly after) the entry
    // pause arriving.
    await call(tools, "wait_for_pause", { timeout_ms: 10_000 });

    // First prove handlers.ts IS mapped — otherwise a no_mapping result on
    // line 999 below could fire for the wrong reason (script not mapped vs.
    // line not in source). `set_breakpoint` returning "set" here means the
    // source-map consumer is loaded; any subsequent no_mapping is genuinely
    // about the line argument.
    const sentinel = await call<{ status: string }>(tools, "set_breakpoint", {
      file: "handlers.ts",
      line: 2,
    });
    expect(sentinel.status).toBe("set");

    // handlers.ts has ~5 lines; line 999 has no mapping.
    const err = await callExpectError(tools, "set_breakpoint", {
      file: "handlers.ts",
      line: 999,
    });
    expect(err.error).toBe("no_mapping");
    // The sentinel above proved the file matched, so the message must take
    // the line-shaped branch (GH #37), not claim the whole file is unknown.
    expect(err.message).toContain("has no executable code");
    expect(err.message).not.toContain("No source-mapped script matches");
  });
});
