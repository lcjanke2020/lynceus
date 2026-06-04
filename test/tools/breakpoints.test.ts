import { describe, it, expect } from "vitest";
import { sessionState, ROOT_SESSION_KEY } from "../../src/session/state.js";
import { registerBreakpointTools } from "../../src/tools/breakpoints.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";
import { seedMappedScript } from "../helpers/source-maps.js";

autoReset();

const tools = captureTools(registerBreakpointTools);
const setBp = tools.get("set_breakpoint")!;
const remove = tools.get("remove_breakpoint")!;
const list = tools.get("list_breakpoints")!;
const setExc = tools.get("set_pause_on_exceptions")!;

describe("set_breakpoint", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    const r = await setBp.handler({ file: "src/foo.ts", line: 7 });
    expect(parseErrorEnvelope(r)?.error).toBe("no_session");
  });

  it("no_mapping error when no script's source map references the file", async () => {
    setupSession();
    const r = await setBp.handler({ file: "src/never-loaded.ts", line: 7 });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("no_mapping");
    expect(err?.message).toContain("src/never-loaded.ts");
    expect(err?.message).toContain("list_scripts");
  });

  it("happy path: binds in the matching script and returns the resolved location", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    const r = parseOkEnvelope<{
      id: string;
      resolved_locations: Array<{ file: string; line: number }>;
      binding_count: number;
      sessions_bound: string[];
      status: "set" | "already-set";
    }>(await setBp.handler({ file: "src/foo.ts", line: 7 }));
    expect(r.id).toMatch(/^bp_\d+$/);
    expect(r.binding_count).toBe(1);
    expect(r.sessions_bound).toEqual([ROOT_SESSION_KEY]);
    expect(r.resolved_locations[0]).toEqual({ file: "src/foo.ts", line: 7, column: 0 });
    expect(r.status).toBe("set");
  });

  it("idempotent: re-setting an identical breakpoint returns the same id with status: 'already-set' and does not hit CDP twice", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    const first = parseOkEnvelope<{ id: string; status: string; resolved_locations: any[] }>(
      await setBp.handler({ file: "src/foo.ts", line: 7 }),
    );
    expect(first.status).toBe("set");
    const second = parseOkEnvelope<{ id: string; status: string; resolved_locations: any[] }>(
      await setBp.handler({ file: "src/foo.ts", line: 7 }),
    );
    expect(second.status).toBe("already-set");
    expect(second.id).toBe(first.id);
    expect(second.resolved_locations).toEqual(first.resolved_locations);
    // CDP should have been hit exactly once across both invocations — the
    // second call must short-circuit before reaching the source-map mapping
    // and Debugger.setBreakpointByUrl. This is the core anti-burn guarantee
    // for issue #17.
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setBreakpointByUrl")).toHaveLength(1);
  });

  it("idempotent: matches on full tuple including condition and log_message", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    const args = { file: "src/foo.ts", line: 7, condition: "x > 5", log_message: "hit x={x}" };
    const first = parseOkEnvelope<{ id: string; status: string }>(await setBp.handler(args));
    const second = parseOkEnvelope<{ id: string; status: string }>(await setBp.handler(args));
    expect(first.status).toBe("set");
    expect(second.status).toBe("already-set");
    expect(second.id).toBe(first.id);
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setBreakpointByUrl")).toHaveLength(1);
  });

  it("breakpoint_conflict when same location has a different condition", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    await setBp.handler({ file: "src/foo.ts", line: 7, condition: "x > 5" });
    const r = await setBp.handler({ file: "src/foo.ts", line: 7, condition: "x > 10" });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("breakpoint_conflict");
    expect(err?.message).toContain("src/foo.ts:7");
    expect(err?.message).toContain("remove_breakpoint");
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setBreakpointByUrl")).toHaveLength(1);
  });

  it("breakpoint_conflict when same location has a different log_message", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    await setBp.handler({ file: "src/foo.ts", line: 7, log_message: "first" });
    const r = await setBp.handler({ file: "src/foo.ts", line: 7, log_message: "second" });
    expect(parseErrorEnvelope(r)?.error).toBe("breakpoint_conflict");
  });

  it("column normalization: omitted column collapses to column 0 (matches list_breakpoints' projection)", async () => {
    // Regression for PR #20 review: list_breakpoints reports omitted column
    // as 0 (breakpoints.ts:list_breakpoints uses `bp.column ?? 0`), so an
    // agent that lists then re-sets walks `{ file, line }` → `{ file, line,
    // column: 0 }`. Both must collapse to the same breakpoint, hit CDP once,
    // and not advance nextBpId — otherwise we leak a dangling record sharing
    // the first record's CDP id.
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    const first = parseOkEnvelope<{ id: string }>(await setBp.handler({ file: "src/foo.ts", line: 7 }));
    const second = parseOkEnvelope<{ id: string; status: string }>(
      await setBp.handler({ file: "src/foo.ts", line: 7, column: 0 }),
    );
    expect(second.status).toBe("already-set");
    expect(second.id).toBe(first.id);
    // Critical invariant: no dangling bp_2 record, no second CDP roundtrip.
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setBreakpointByUrl")).toHaveLength(1);
  });

  it("column normalization: explicit column 0 then omitted column also collapses (reverse cycle)", async () => {
    // Same bug shape as above, but the first call carries `column: 0` and
    // the retry omits it. Pre-fix: stored r.column = 0, second's
    // input.column = undefined, strict `=== undefined` → no match → dangling
    // record. Post-fix: both normalize to 0 → match.
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}:${params.lineNumber}`,
      locations: [{ scriptId: "s1", lineNumber: params.lineNumber, columnNumber: 0 }],
    }));
    fake.clearSentCalls();
    const first = parseOkEnvelope<{ id: string }>(await setBp.handler({ file: "src/foo.ts", line: 7, column: 0 }));
    const second = parseOkEnvelope<{ id: string; status: string }>(
      await setBp.handler({ file: "src/foo.ts", line: 7 }),
    );
    expect(second.status).toBe("already-set");
    expect(second.id).toBe(first.id);
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setBreakpointByUrl")).toHaveLength(1);
  });

  it("multi-script binding: same TS file in two scripts → 2 bindings, both sessions reported", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s_root", url: "http://x/page.js", source: "src/util.ts", tsLine: 5, jsLine: 1 });
    seedMappedScript({ scriptId: "s_worker", url: "http://x/worker.js", source: "src/util.ts", sessionId: "SW1", tsLine: 5, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any, sid?: string) => ({
      // Different cdpIds per session — verify the per-session bindings are tracked.
      breakpointId: `cdp:${sid ?? "root"}:${params.url}`,
      locations: [{ scriptId: sid === "SW1" ? "s_worker" : "s_root", lineNumber: 0, columnNumber: 0 }],
    }));
    const r = parseOkEnvelope<{ binding_count: number; sessions_bound: string[] }>(
      await setBp.handler({ file: "src/util.ts", line: 5 }),
    );
    expect(r.binding_count).toBe(2);
    expect(r.sessions_bound).toHaveLength(2);
    expect(r.sessions_bound).toEqual(expect.arrayContaining([ROOT_SESSION_KEY, "SW1"]));
  });

  it("forwards condition and logMessage as a combined CDP `condition` expression", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.clearSentCalls();
    await setBp.handler({ file: "src/foo.ts", line: 7, condition: "x > 5", log_message: "hit x={x}" });
    const call = fake.sentCalls.find((c) => c.method === "Debugger.setBreakpointByUrl");
    expect(call?.params.condition).toMatch(/^\(x > 5\) && \(/);
    expect(call?.params.condition).toContain(", false)");
  });

  it("uses url (not urlRegex) — avoids unanchored regex matching against query strings", async () => {
    // Documented at src/tools/breakpoints.ts:34. Regression guard.
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://localhost/main.js", source: "src/main.ts", tsLine: 3, jsLine: 1 });
    fake.clearSentCalls();
    await setBp.handler({ file: "src/main.ts", line: 3 });
    const call = fake.sentCalls.find((c) => c.method === "Debugger.setBreakpointByUrl");
    expect(call?.params.url).toBe("http://localhost/main.js");
    expect(call?.params.urlRegex).toBeUndefined();
  });
});

describe("remove_breakpoint", () => {
  it("not_found error for unknown id", async () => {
    setupSession();
    const r = await remove.handler({ id: "bp_999" });
    expect(parseErrorEnvelope(r)).toEqual({
      error: "not_found",
      message: expect.stringContaining("bp_999"),
    });
  });

  it("issues Debugger.removeBreakpoint per binding and drops the record", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", (params: any) => ({
      breakpointId: `cdp:${params.url}`,
      locations: [{ scriptId: "s1", lineNumber: 0, columnNumber: 0 }],
    }));
    const set = parseOkEnvelope<{ id: string }>(await setBp.handler({ file: "src/foo.ts", line: 7 }));
    fake.clearSentCalls();
    const removed = await remove.handler({ id: set.id });
    expect(parseOkEnvelope(removed)).toBe("removed");
    expect(fake.sentCalls.find((c) => c.method === "Debugger.removeBreakpoint")).toBeDefined();
    // list_breakpoints now returns no entries.
    expect(parseOkEnvelope<any[]>(await list.handler({}))).toEqual([]);
  });

  it("CDP failure during removeBreakpoint is swallowed (session may already be gone)", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", () => ({ breakpointId: "cdp:1", locations: [] }));
    const set = parseOkEnvelope<{ id: string }>(await setBp.handler({ file: "src/foo.ts", line: 7 }));
    fake.respond("Debugger.removeBreakpoint", () => {
      throw new Error("session detached");
    });
    // Must NOT throw — production swallows per-binding failures because the
    // session may already be gone (worker terminated, iframe navigated away).
    expect(parseOkEnvelope(await remove.handler({ id: set.id }))).toBe("removed");
  });
});

describe("list_breakpoints", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await list.handler({}))?.error).toBe("no_session");
  });

  it("returns the projected shape with resolved_locations + binding_count", async () => {
    const { fake } = setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    fake.respond("Debugger.setBreakpointByUrl", () => ({
      breakpointId: "cdp:1",
      locations: [{ scriptId: "s1", lineNumber: 0, columnNumber: 0 }],
    }));
    await setBp.handler({ file: "src/foo.ts", line: 7, condition: "true" });
    const items = parseOkEnvelope<any[]>(await list.handler({}));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      file: "src/foo.ts",
      line: 7,
      condition: "true",
      binding_count: 1,
      resolved_locations: [{ file: "src/foo.ts", line: 7, column: 0 }],
    });
  });
});

describe("set_pause_on_exceptions", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await setExc.handler({ state: "all" }))?.error).toBe("no_session");
  });

  it("persists state on sessionState.pauseOnExceptions for child-attach replay", async () => {
    setupSession();
    sessionState.sessionHandlers.set(ROOT_SESSION_KEY, []);
    await setExc.handler({ state: "uncaught" });
    expect(sessionState.pauseOnExceptions).toBe("uncaught");
  });

  it("applies to every currently-attached session (root + children)", async () => {
    const { fake } = setupSession();
    sessionState.sessionHandlers.set(ROOT_SESSION_KEY, []);
    sessionState.sessionHandlers.set("SW1", []);
    sessionState.sessionHandlers.set("IF1", []);
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ sessions_applied: number; failures: any[] }>(
      await setExc.handler({ state: "all" }),
    );
    expect(r.sessions_applied).toBe(3);
    expect(r.failures).toEqual([]);
    const sessions = fake.sentCalls
      .filter((c) => c.method === "Debugger.setPauseOnExceptions")
      .map((c) => c.sessionId);
    // root → undefined; children → string sessionIds. Order is unstable
    // (Promise.allSettled, plus Map iteration order), so assert the set.
    expect(sessions).toHaveLength(3);
    expect(sessions).toEqual(expect.arrayContaining([undefined, "IF1", "SW1"]));
  });

  it("partial failure: reports per-session error in failures[] without aborting the rest", async () => {
    const { fake } = setupSession();
    sessionState.sessionHandlers.set(ROOT_SESSION_KEY, []);
    sessionState.sessionHandlers.set("SW1", []);
    fake.respond("Debugger.setPauseOnExceptions", (_p: any, sid?: string) => {
      if (sid === "SW1") throw new Error("worker terminated");
      return undefined;
    });
    const r = parseOkEnvelope<{ sessions_applied: number; failures: Array<{ sid: string; error: string }> }>(
      await setExc.handler({ state: "all" }),
    );
    expect(r.sessions_applied).toBe(1); // root succeeded
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.sid).toBe("SW1");
    expect(r.failures[0]?.error).toContain("worker terminated");
  });

  it("safety net: if no sessionHandlers exist, defaults to root-only application", async () => {
    const { fake } = setupSession();
    // Don't populate sessionHandlers — the production safety net pushes
    // undefined so the call still goes out at least once.
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ sessions_applied: number }>(await setExc.handler({ state: "none" }));
    expect(r.sessions_applied).toBe(1);
    expect(fake.sentCalls.filter((c) => c.method === "Debugger.setPauseOnExceptions").length).toBe(1);
  });
});

describe("registration metadata", () => {
  it("registers exactly the four breakpoint tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "list_breakpoints",
      "remove_breakpoint",
      "set_breakpoint",
      "set_pause_on_exceptions",
    ]);
  });
});
