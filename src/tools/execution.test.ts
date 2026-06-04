import { describe, it, expect } from "vitest";
import { matchUserBreakpoints } from "./execution.js";
import type { BreakpointRecord } from "../session/state.js";

// `matchUserBreakpoints` resolves a Chrome-reported list of hit cdpIds back
// to the user-facing breakpoint IDs the agent set. The trap (Codex PR#5 #2):
// `Debugger.setBreakpointByUrl` derives its breakpoint ID from URL+line+col,
// so a single breakpoint bound in two sessions (worker + page) can mint
// colliding cdpIds. Without the sessionId guard, a pause in one session
// would falsely report as a hit for the OTHER session's binding — mapping
// the agent's "set bp in src/main.ts" to a worker binding. The fix requires
// BOTH cdpId AND sessionId match.

// Build a SessionState-shaped object with just the field matchUserBreakpoints
// reads (`.breakpoints`). The function's signature accepts the full Session,
// but the body only touches one field — a partial cast is type-safe enough.
function fakeSession(records: BreakpointRecord[]) {
  const breakpoints = new Map<string, BreakpointRecord>();
  for (const r of records) breakpoints.set(r.id, r);
  return { breakpoints } as unknown as Parameters<typeof matchUserBreakpoints>[0];
}

const bp = (id: string, bindings: Array<{ cdpId: string; sessionId?: string }>): BreakpointRecord => ({
  id,
  file: "src/foo.ts",
  line: 1,
  resolvedLocations: [],
  bindings,
});

describe("matchUserBreakpoints", () => {
  it("returns [] when no breakpoints have been hit", () => {
    const s = fakeSession([bp("bp_1", [{ cdpId: "1:0:0:http://x" }])]);
    expect(matchUserBreakpoints(s, [], undefined)).toEqual([]);
  });

  it("returns the user id when cdpId matches in the root session", () => {
    const s = fakeSession([bp("bp_1", [{ cdpId: "abc" }])]);
    expect(matchUserBreakpoints(s, ["abc"], undefined)).toEqual(["bp_1"]);
  });

  it("returns the user id when cdpId AND child sessionId both match", () => {
    const s = fakeSession([bp("bp_1", [{ cdpId: "abc", sessionId: "SW1" }])]);
    expect(matchUserBreakpoints(s, ["abc"], "SW1")).toEqual(["bp_1"]);
  });

  it("does NOT match when cdpId matches but sessionId differs (worker→root regression)", () => {
    // The codex regression: setBreakpointByUrl returned cdpId "abc" for
    // both the root binding (sessionId undefined) and the worker binding
    // (sessionId "SW1"). A pause in the worker reports hitBreakpoints=["abc"]
    // and pauseSessionId="SW1". Pre-fix, the root binding (sessionId
    // undefined) ALSO matched because only cdpId was checked, so the agent
    // saw "bp_1 hit in root session" when actually the worker paused.
    const s = fakeSession([bp("bp_1_root", [{ cdpId: "abc" }])]);
    expect(matchUserBreakpoints(s, ["abc"], "SW1")).toEqual([]);
  });

  it("does NOT match when sessionId matches but cdpId differs", () => {
    const s = fakeSession([bp("bp_1", [{ cdpId: "abc", sessionId: "SW1" }])]);
    expect(matchUserBreakpoints(s, ["xyz"], "SW1")).toEqual([]);
  });

  it("root vs child collision: same cdpId in two breakpoints, only the one whose sessionId matches the pause is returned", () => {
    // Concrete worker-collision regression: same script ID gets bound under
    // both root and worker sessions, both produce identical cdpIds, and a
    // pause in the worker should ONLY report the worker binding.
    const s = fakeSession([
      bp("bp_root", [{ cdpId: "shared-cdp-id" }]),
      bp("bp_worker", [{ cdpId: "shared-cdp-id", sessionId: "SW1" }]),
    ]);
    expect(matchUserBreakpoints(s, ["shared-cdp-id"], "SW1")).toEqual(["bp_worker"]);
    expect(matchUserBreakpoints(s, ["shared-cdp-id"], undefined)).toEqual(["bp_root"]);
  });

  it("returns multiple ids when multiple distinct user breakpoints share the same hit cdpId in the same session", () => {
    // Edge case: agent sets two logically-different breakpoints that
    // happen to bind to the same physical location (rare but possible
    // via overlapping file:line via different conditions).
    const s = fakeSession([
      bp("bp_a", [{ cdpId: "abc" }]),
      bp("bp_b", [{ cdpId: "abc" }]),
    ]);
    const out = matchUserBreakpoints(s, ["abc"], undefined);
    expect(out.sort()).toEqual(["bp_a", "bp_b"]);
  });

  it("breakpoint with multiple bindings: matches if any binding matches", () => {
    // A single user breakpoint set in src/foo.ts may bind to TWO scripts
    // (e.g. main page + iframe), each producing its own cdpId+sessionId.
    // A pause in either session should resolve back to the same user id.
    const s = fakeSession([
      bp("bp_1", [
        { cdpId: "cdp-page" },
        { cdpId: "cdp-iframe", sessionId: "IF1" },
      ]),
    ]);
    expect(matchUserBreakpoints(s, ["cdp-page"], undefined)).toEqual(["bp_1"]);
    expect(matchUserBreakpoints(s, ["cdp-iframe"], "IF1")).toEqual(["bp_1"]);
    // But NOT when the iframe's cdpId is hit in the wrong session:
    expect(matchUserBreakpoints(s, ["cdp-iframe"], undefined)).toEqual([]);
  });

  it("ignores breakpoints with no bindings", () => {
    // BreakpointRecord can theoretically exist with empty bindings (e.g.
    // mid-bind state, or after all child sessions detach). `.some` returns
    // false on empty, so we rely on that — but worth a regression test.
    const s = fakeSession([bp("bp_orphan", [])]);
    expect(matchUserBreakpoints(s, ["abc"], undefined)).toEqual([]);
  });
});
