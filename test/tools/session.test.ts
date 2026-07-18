import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { getSession, registry } from "../../src/session/state.js";
import { makeFakeCdp, type FakeCdp } from "../fake-cdp.js";

// IMPLEMENTATION NOTE (Opus PR #10 round-2 Nit): this file uses `vi.mock`
// to stub chrome-launcher and chrome-remote-interface, deliberately
// breaking the unified setupSession() fake-client seam pattern that
// every other tool-test file uses. Reason: chrome-launcher's `launch()`
// and chrome-remote-interface's default export + `.List` are STATIC
// imports — they're resolved at module-load time, before the session
// registry even exists. There's no runtime seam to redirect them through;
// only vitest's module mocking can intercept them. Don't try to "unify the
// style" here; the asymmetry is structural.

// Mock chrome-launcher so launch_chrome doesn't actually spawn Chrome.
const launchMock = vi.fn<(opts: any) => Promise<{ port: number; pid: number; kill: () => void }>>();
vi.mock("chrome-launcher", () => ({
  launch: (opts: any) => launchMock(opts),
}));

// Mock chrome-remote-interface — both the default export (CDP() constructor)
// and CDP.List (used by attach_chrome / list_targets / select_target).
const cdpListMock = vi.fn<(opts: any) => Promise<any[]>>();
let nextFakeForConnect: FakeCdp | null = null;
vi.mock("chrome-remote-interface", () => {
  const def: any = (_opts: any) => Promise.resolve(nextFakeForConnect);
  def.List = (opts: any) => cdpListMock(opts);
  return { default: def };
});

// Mock mkdirSync so the snap auto-userDataDir branch in launchChrome doesn't
// actually create directories under the test runner's home (on non-Linux
// hosts ~/snap/... would be nonsensical pollution). Other fs exports stay
// real — browser-resolve.ts uses existsSync/readdirSync/realpathSync/etc.
// The mock callable is wrapped in an arrow so vitest's hoist of vi.mock
// doesn't try to read mkdirSyncMock before it's declared (same pattern as
// launchMock / cdpListMock above).
const mkdirSyncMock = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: (...args: any[]) => mkdirSyncMock(...args) };
});

// Mock child_process.spawn so launch_node can exercise process ownership and
// inspector-startup parsing without creating real Node children in L2.
const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: any[]) => spawnMock(...args) };
});

// Imports MUST come after vi.mock so the registrar sees the mocked modules.
import { registerSessionTools } from "../../src/tools/session.js";
import { autoReset, setupSession } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerSessionTools);
const launchChrome = tools.get("launch_chrome")!;
const attachChrome = tools.get("attach_chrome")!;
const attachNode = tools.get("attach_node")!;
const launchNode = tools.get("launch_node")!;
const closeSession = tools.get("close_session")!;
const listTargets = tools.get("list_targets")!;
const selectTarget = tools.get("select_target")!;

beforeEach(() => {
  launchMock.mockReset();
  cdpListMock.mockReset();
  mkdirSyncMock.mockReset();
  spawnMock.mockReset();
  delete process.env.CHROME_PATH;
  nextFakeForConnect = makeFakeCdp();
});

function makeFakeNodeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = vi.fn(() => {
    if (!killed) {
      killed = true;
      child.emit("exit", null, "SIGTERM");
    }
    return true;
  });
  return child;
}

function mockNodeInspectorStartup(child = makeFakeNodeChild(), port = 4567) {
  spawnMock.mockImplementation(() => {
    setImmediate(() => {
      child.stderr.write(`Debugger listening on ws://127.0.0.1:${port}/abc\n`);
    });
    return child;
  });
  return child;
}

describe("launch_chrome", () => {
  it("happy path: spawns chrome, picks the first page target, attaches", async () => {
    launchMock.mockResolvedValue({ port: 9999, pid: 12345, kill: vi.fn() });
    cdpListMock.mockResolvedValue([
      { id: "t1", type: "page", url: "about:blank", title: "" },
    ]);
    const r = parseOkEnvelope<{ targetId: string; url: string }>(
      await launchChrome.handler({ url: "http://x", headless: true }),
    );
    expect(r.targetId).toBe("t1");
    expect(r.url).toBe("about:blank");
    // chrome-launcher received the right flags.
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.startingUrl).toBe("http://x");
    // --remote-debugging-port is NOT in chromeFlags — chrome-launcher
    // manages port selection. Passing our own flag overrode chrome-
    // launcher's and caused ECONNREFUSED on the polling side (Codex
    // blocker on PR #11). Assert it stays out.
    expect(call?.chromeFlags).not.toContain("--remote-debugging-port=0");
    expect(call?.chromeFlags).toContain("--headless=new");
  });

  it("forwards chrome_path to chrome-launcher's chromePath option AND auto-derives the snap userDataDir (snap-confinement workaround)", async () => {
    // The whole reason chrome_path was added: chrome-launcher's auto-detection
    // misses snap-installed Chromium, and on Linux ARM64 Google doesn't ship
    // Chrome. Tests must verify the option flows end-to-end.
    // Snap confinement rejects /tmp/... user-data-dir; ~/snap/<app>/current/
    // is the only writable path. launchChrome must auto-derive that path when
    // the effective chrome path is under /snap/ so the agent (and the L4
    // harness via CHROME_PATH env) doesn't have to remember to set
    // user_data_dir. (Codex review on PR #24.)
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "about:blank", title: "" }]);
    await launchChrome.handler({ chrome_path: "/snap/bin/chromium" });
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.chromePath).toBe("/snap/bin/chromium");
    expect(call?.userDataDir).toMatch(/[/\\]snap[/\\]chromium[/\\]current[/\\]lynceus-test-profile$/);
    // mkdirSync(udd, { recursive: true }) ran so the dir exists before chrome
    // tries to write its first-run lock + chrome-out.log into it. (Issue #13.)
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]snap[/\\]chromium[/\\]current[/\\]lynceus-test-profile$/),
      { recursive: true },
    );
  });

  it("explicit user_data_dir wins over the snap auto-derive — caller stays in control", async () => {
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "about:blank", title: "" }]);
    await launchChrome.handler({
      chrome_path: "/snap/bin/chromium",
      user_data_dir: "/custom/profile",
    });
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.userDataDir).toBe("/custom/profile");
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  it("CHROME_PATH env triggers snap auto-derive even without explicit chrome_path (L4 eval-harness path)", async () => {
    // The L4 harness sets CHROME_PATH on the spawned MCP subprocess; the agent
    // calls launch_chrome with no chrome_path. The snap-userDataDir workaround
    // must fire just the same — chrome-launcher would otherwise honor
    // CHROME_PATH but hand snap-Chromium a /tmp/ profile. (Codex review,
    // PR #24.)
    process.env.CHROME_PATH = "/snap/bin/chromium";
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "about:blank", title: "" }]);
    await launchChrome.handler({});
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.userDataDir).toMatch(/[/\\]snap[/\\]chromium[/\\]current[/\\]lynceus-test-profile$/);
    expect(mkdirSyncMock).toHaveBeenCalled();
  });

  it("non-snap chrome_path does not trigger the auto-derive — userDataDir stays undefined", async () => {
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "about:blank", title: "" }]);
    await launchChrome.handler({ chrome_path: "/usr/bin/chromium" });
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.userDataDir).toBeUndefined();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  it("user_data_dir and args flow through; explicit --no-sandbox in args is not duplicated", async () => {
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
    await launchChrome.handler({ user_data_dir: "/tmp/profile", args: ["--no-sandbox"] });
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.userDataDir).toBe("/tmp/profile");
    expect(call?.chromeFlags).toContain("--no-sandbox");
    expect(call?.chromeFlags.filter((f: string) => f === "--no-sandbox")).toHaveLength(1);
  });

  it("defaults to --no-sandbox so launches work on Ubuntu 23.10+ where AppArmor restricts userns", async () => {
    // Rationale: Playwright-bundled Chromium has no SUID chrome_sandbox helper,
    // and Ubuntu 23.10+ restricts unprivileged user namespaces via AppArmor,
    // so without --no-sandbox Chromium FATALs at startup. The MCP server
    // already grants Runtime.evaluate / DOM driving — the per-process sandbox
    // isn't the trust boundary. Default-on so eval/automation flows work
    // out-of-the-box.
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
    await launchChrome.handler({});
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.chromeFlags).toContain("--no-sandbox");
  });

  it("sandbox: true suppresses the default --no-sandbox", async () => {
    launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
    cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
    await launchChrome.handler({ sandbox: true });
    const call = launchMock.mock.calls[0]?.[0];
    expect(call?.chromeFlags).not.toContain("--no-sandbox");
  });

  it("CDP_SANDBOX=true makes an arg-less launch default to sandbox-on (no --no-sandbox)", async () => {
    // The L4 eval runner sets CDP_SANDBOX=true (via EVAL_SANDBOX) so a whole
    // suite runs sandbox-on without the model passing `sandbox` on every call.
    const prev = process.env.CDP_SANDBOX;
    process.env.CDP_SANDBOX = "true";
    try {
      launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
      cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
      await launchChrome.handler({});
      const call = launchMock.mock.calls[0]?.[0];
      expect(call?.chromeFlags).not.toContain("--no-sandbox");
    } finally {
      if (prev === undefined) delete process.env.CDP_SANDBOX;
      else process.env.CDP_SANDBOX = prev;
    }
  });

  it("CDP_SANDBOX=1 also enables (parses true/1, matching EVAL_SANDBOX)", async () => {
    const prev = process.env.CDP_SANDBOX;
    process.env.CDP_SANDBOX = "1";
    try {
      launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
      cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
      await launchChrome.handler({});
      const call = launchMock.mock.calls[0]?.[0];
      expect(call?.chromeFlags).not.toContain("--no-sandbox");
    } finally {
      if (prev === undefined) delete process.env.CDP_SANDBOX;
      else process.env.CDP_SANDBOX = prev;
    }
  });

  it("explicit sandbox:false forces --no-sandbox even when CDP_SANDBOX=true", async () => {
    const prev = process.env.CDP_SANDBOX;
    process.env.CDP_SANDBOX = "true";
    try {
      launchMock.mockResolvedValue({ port: 9999, pid: 1, kill: vi.fn() });
      cdpListMock.mockResolvedValue([{ id: "t1", type: "page", url: "x", title: "" }]);
      await launchChrome.handler({ sandbox: false });
      const call = launchMock.mock.calls[0]?.[0];
      expect(call?.chromeFlags).toContain("--no-sandbox");
    } finally {
      if (prev === undefined) delete process.env.CDP_SANDBOX;
      else process.env.CDP_SANDBOX = prev;
    }
  });

  it("already_session error when a session is already active", async () => {
    setupSession();
    const r = await launchChrome.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("already_session");
  });
});

describe("attach_chrome", () => {
  it("happy path: filters to type=page by default and picks the first match", async () => {
    cdpListMock.mockResolvedValue([
      { id: "sw", type: "service_worker", url: "ws://x" },
      { id: "page1", type: "page", url: "http://x/" },
      { id: "page2", type: "page", url: "http://x/about" },
    ]);
    const r = parseOkEnvelope<{ targetId: string; url: string }>(
      await attachChrome.handler({ port: 9222 }),
    );
    expect(r.targetId).toBe("page1");
  });

  it("target_filter.url_includes narrows the page set", async () => {
    cdpListMock.mockResolvedValue([
      { id: "page1", type: "page", url: "http://x/" },
      { id: "page2", type: "page", url: "http://x/admin" },
    ]);
    const r = parseOkEnvelope<{ targetId: string }>(
      await attachChrome.handler({ port: 9222, target_filter: { url_includes: "admin" } }),
    );
    expect(r.targetId).toBe("page2");
  });

  it("target_filter.type overrides the default 'page' filter", async () => {
    cdpListMock.mockResolvedValue([
      { id: "page1", type: "page", url: "http://x/" },
      { id: "sw1", type: "service_worker", url: "ws://x" },
    ]);
    const r = parseOkEnvelope<{ targetId: string }>(
      await attachChrome.handler({ target_filter: { type: "service_worker" } }),
    );
    expect(r.targetId).toBe("sw1");
  });

  it("throws when no target matches the filter", async () => {
    cdpListMock.mockResolvedValue([{ id: "p1", type: "page", url: "http://x" }]);
    const r = await attachChrome.handler({ target_filter: { type: "iframe" } });
    expect(parseErrorEnvelope(r)?.message).toContain("No matching targets");
  });

  it("already_session error when session already exists", async () => {
    setupSession();
    const r = await attachChrome.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("already_session");
  });
});

describe("attach_node", () => {
  it("happy path: connects via CDP.List + CDP(), sets kind='node', attached=true, ownedProcess=null", async () => {
    cdpListMock.mockResolvedValue([
      { id: "node-target-1", type: "node", url: "file:///app/server.js" },
    ]);
    const r = parseOkEnvelope<{ targetId: string; url: string }>(
      await attachNode.handler({ port: 9229 }),
    );
    expect(r).toEqual({ targetId: "node-target-1", url: "file:///app/server.js" });
    expect(cdpListMock).toHaveBeenCalledWith({ port: 9229, host: "127.0.0.1" });
    const s = getSession()!;
    expect(s.kind).toBe("node");
    expect(s.attached).toBe(true);
    // Attach mode: we did NOT launch the process, so ownedProcess stays
    // null and close_session won't kill it.
    expect(s.ownedProcess).toBeNull();
    expect(s.currentTargetId).toBe("node-target-1");
    expect(s.chromePort).toBe(9229);
  });

  it("defaults port=9229, host=127.0.0.1 when neither is supplied", async () => {
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await attachNode.handler({});
    expect(cdpListMock).toHaveBeenCalledWith({ port: 9229, host: "127.0.0.1" });
  });

  it("enables ONLY Runtime + Debugger, calls Runtime.runIfWaitingForDebugger, does NOT call Debugger.resume / Page.enable / DOM.enable / Network.enable / Target.setAutoAttach", async () => {
    // The contract that makes attach_node safe for Node sessions: Node
    // inspector has no Page/DOM/Network domains. Calling them surfaces
    // raw CDP errors. setAutoAttach is also browser-only (Node has no
    // child sessions in v1). Debugger.resume must NOT fire because the
    // entry pause flows through PauseTracker — the agent installs
    // breakpoints from the stopped state and calls resume() explicitly.
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    const fake = nextFakeForConnect!;
    await attachNode.handler({});
    const methods = fake.sentCalls.map((c) => c.method);
    expect(methods).toContain("Runtime.enable");
    expect(methods).toContain("Debugger.enable");
    expect(methods).toContain("Runtime.runIfWaitingForDebugger");
    // Order: runIfWaitingForDebugger comes AFTER Debugger.enable. Without
    // this, V8 never fires the entry pause for --inspect-brk (empirically
    // verified on Node v24.13.1).
    expect(methods.indexOf("Runtime.runIfWaitingForDebugger")).toBeGreaterThan(
      methods.indexOf("Debugger.enable"),
    );
    // Browser-only domains must NOT be enabled.
    expect(methods).not.toContain("Page.enable");
    expect(methods).not.toContain("DOM.enable");
    expect(methods).not.toContain("Network.enable");
    expect(methods).not.toContain("Target.setAutoAttach");
    // Debugger.resume must NOT fire — the entry pause is the contract.
    expect(methods).not.toContain("Debugger.resume");
  });

  it("already_session error when a session is already active", async () => {
    setupSession();
    const r = await attachNode.handler({ port: 9229 });
    expect(parseErrorEnvelope(r)?.error).toBe("already_session");
    // CDP.List must NOT have been called — the guard runs first.
    expect(cdpListMock).not.toHaveBeenCalled();
  });

  it("throws when /json/list returns no inspector targets", async () => {
    cdpListMock.mockResolvedValue([]);
    const r = await attachNode.handler({ port: 9229 });
    expect(parseErrorEnvelope(r)?.message).toContain("No Node inspector targets");
  });

  it("filters /json/list to type='node' so a stray non-Node entry doesn't get picked up (Ultrareview round 2 — Copilot node.ts:48)", async () => {
    // The /json/list endpoint normally returns one entry per --inspect process,
    // but be explicit so a hypothetical mixed list doesn't silently surface a
    // wrong target. Here the only target is type='page' — attach_node should
    // refuse with a message that names the types it actually saw.
    cdpListMock.mockResolvedValue([
      { id: "p1", type: "page", url: "http://x/" },
    ]);
    const r = await attachNode.handler({ port: 9229 });
    const msg = parseErrorEnvelope(r)?.message;
    expect(msg).toContain("No Node inspector targets");
    expect(msg).toContain("got types=[page]");
  });

  it("picks the type='node' target when the list contains mixed types (Ultrareview round 2)", async () => {
    cdpListMock.mockResolvedValue([
      { id: "sw1", type: "service_worker", url: "http://x/sw.js" },
      { id: "n1", type: "node", url: "file:///app/server.js" },
    ]);
    const r = parseOkEnvelope<{ targetId: string; url: string }>(
      await attachNode.handler({ port: 9229 }),
    );
    expect(r.targetId).toBe("n1");
  });

  it("persists host on the session so follow-up CDP.List calls don't fall back to localhost (Ultrareview round 2 — Copilot node.ts:53)", async () => {
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await attachNode.handler({ host: "10.0.0.5", port: 9229 });
    const s = getSession()!;
    expect(s.chromeHost).toBe("10.0.0.5");
    expect(s.chromePort).toBe(9229);
    // Verify list_targets re-uses the persisted host (otherwise a remote
    // attach silently lists localhost targets instead).
    cdpListMock.mockClear();
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    await listTargets.handler({});
    expect(cdpListMock).toHaveBeenCalledWith({ port: 9229, host: "10.0.0.5" });
  });

  it("tears the partial session down + surfaces the error when Debugger.enable rejects (Ultrareview round 2 — Codex Medium #1)", async () => {
    // Before this fix, connectDebugger swallowed Runtime/Debugger.enable
    // errors and attach_node returned success with a half-attached state:
    // no entry pause would fire, no breakpoints would resolve. Now the
    // failure propagates AND the session is rolled back so a follow-up
    // attach attempt isn't blocked by already_session.
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    const fake = nextFakeForConnect!;
    fake.respond("Debugger.enable", () => {
      throw new Error("CDP: Debugger.enable not supported on this target");
    });
    const r = await attachNode.handler({ port: 9229 });
    const err = parseErrorEnvelope(r);
    expect(err?.message).toContain("Debugger.enable not supported");
    // The reservation must be fully aborted — the next attach must not see
    // already_session against the dead client. (The failed session's
    // instance is unreachable by design: it was never activated, so the
    // registry-level "no session" IS the reset contract now.)
    expect(getSession()).toBeNull();
    // ...and prove it end-to-end (round-1 review: getSession()===null alone
    // can't distinguish "slot freed" from "record wedged with a null
    // client" — only a successful follow-up attach can).
    nextFakeForConnect = makeFakeCdp();
    const r2 = parseOkEnvelope<{ targetId: string }>(await attachNode.handler({ port: 9229 }));
    expect(r2.targetId).toBe("n1");
  });

  it("select_target returns unsupported_target on a Node session (self-protection)", async () => {
    // Without this gate, switchTarget would try to re-run the browser-
    // specific reconnect flow against a Node target (CDP.List with no
    // type filter, then connectToTarget which calls enableBrowserDomains).
    // The capability table's original entry exists exactly so the state
    // refactor (removing sessionState.chrome) can't silently misbehave on
    // a Node session.
    const { session } = setupSession({ kind: "node", chromePort: 9229 });
    session.currentTargetId = "n1";
    const r = await selectTarget.handler({ id: "n2" });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("unsupported_target");
    expect(err?.message).toBe(
      "Tool select_target requires a browser session (current session is node)",
    );
  });
});

describe("launch_node", () => {
  const fixtureScript = "test/fixtures/node-launch-entry.js";

  it("happy path: spawns node under --inspect-brk on an ephemeral port, attaches, and owns the child", async () => {
    const child = mockNodeInspectorStartup(makeFakeNodeChild(1234), 4567);
    cdpListMock.mockResolvedValue([
      { id: "node-target-1", type: "node", url: "file:///app/dist/index.js" },
    ]);

    const r = parseOkEnvelope<{
      targetId: string;
      url: string;
      pid: number;
      port: number;
      inspectMode: string;
      cwd: string;
      script: string;
    }>(await launchNode.handler({ script: fixtureScript }));

    expect(r.targetId).toBe("node-target-1");
    expect(r.url).toBe("file:///app/dist/index.js");
    expect(r.pid).toBe(1234);
    expect(r.port).toBe(4567);
    expect(r.inspectMode).toBe("inspect-brk");
    expect(r.cwd).toBe(process.cwd());
    expect(r.script).toBe(resolve(process.cwd(), fixtureScript));

    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([
      "--inspect-brk=127.0.0.1:0",
      resolve(process.cwd(), fixtureScript),
    ]);
    expect(opts).toMatchObject({ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    expect(cdpListMock).toHaveBeenCalledWith({ port: 4567, host: "127.0.0.1" });
    const s = getSession()!;
    expect(s.kind).toBe("node");
    expect(s.attached).toBe(false);
    expect(s.ownedProcess).toEqual({ kind: "node", handle: child });
  });

  it("forwards cwd, script args, env overrides, inspect mode, and explicit inspector port", async () => {
    mockNodeInspectorStartup(makeFakeNodeChild(), 9333);
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    const cwd = resolve(process.cwd(), "test/fixtures");

    await launchNode.handler({
      script: "node-launch-entry.js",
      args: ["one", "two"],
      cwd,
      env: { LYNCEUS_TEST_VALUE: "yes" },
      inspect_mode: "inspect",
      inspect_port: 9333,
    });

    const [, args, opts] = spawnMock.mock.calls[0]!;
    expect(args).toEqual([
      "--inspect=127.0.0.1:9333",
      resolve(cwd, "node-launch-entry.js"),
      "one",
      "two",
    ]);
    expect(opts.cwd).toBe(cwd);
    expect(opts.env.LYNCEUS_TEST_VALUE).toBe("yes");
  });

  it("already_session error runs before spawning a child", async () => {
    setupSession();
    const r = await launchNode.handler({ script: fixtureScript });
    expect(parseErrorEnvelope(r)?.error).toBe("already_session");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("not_found error for a missing script runs before spawning a child", async () => {
    const r = await launchNode.handler({ script: "test/fixtures/does-not-exist.js" });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("not_found");
    expect(err?.message).toContain("script not found");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("surfaces startup output when the child exits before the inspector listens", async () => {
    const child = makeFakeNodeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.write("Starting inspector on 127.0.0.1:9229 failed: address already in use\n");
        child.emit("exit", 9, null);
      });
      return child;
    });

    const r = await launchNode.handler({ script: fixtureScript, inspect_port: 9229 });
    const err = parseErrorEnvelope(r);
    expect(err?.error).toBe("launch_failed");
    expect(err?.message).toContain("exited before the inspector started");
    expect(err?.message).toContain("address already in use");
    expect(child.kill).toHaveBeenCalled();
    expect(cdpListMock).not.toHaveBeenCalled();
  });

  it("cleans up the launched child and session state if inspector attach fails", async () => {
    const child = mockNodeInspectorStartup(makeFakeNodeChild(), 4567);
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    nextFakeForConnect!.respond("Debugger.enable", () => {
      throw new Error("Debugger unavailable");
    });

    const r = await launchNode.handler({ script: fixtureScript });
    const err = parseErrorEnvelope(r);
    expect(err?.message).toContain("Debugger unavailable");
    expect(child.kill).toHaveBeenCalled();
    // The failed launch aborted its reservation — no session survives (the
    // never-activated instance is unreachable by design).
    expect(getSession()).toBeNull();
    // ...and prove the slot is actually free (round-1 review): a follow-up
    // launch must succeed, not hit already_session against a wedged record.
    mockNodeInspectorStartup(makeFakeNodeChild(), 4568);
    nextFakeForConnect = makeFakeCdp();
    const r2 = parseOkEnvelope<{ targetId: string }>(
      await launchNode.handler({ script: fixtureScript }),
    );
    expect(r2.targetId).toBe("n1");
  });

  it("close-all racing an in-flight launch: launch errors, cleans up, and frees the slot (round-1 review)", async () => {
    // Shutdown-races-launch: closeAll() tears down the "starting"
    // reservation while the launch is still connecting. The strict
    // activate() invariant must turn the late activation into a loud
    // failure (not a silent success for an untracked live session), the
    // catch path must release the just-connected client and child, and the
    // slot must end up free.
    const child = mockNodeInspectorStartup(makeFakeNodeChild(), 4567);
    cdpListMock.mockImplementation(async () => {
      await registry.closeAll();
      return [{ id: "n1", type: "node", url: "" }];
    });
    const r = await launchNode.handler({ script: fixtureScript });
    expect(parseErrorEnvelope(r)).not.toBeNull();
    expect(child.kill).toHaveBeenCalled();
    expect(getSession()).toBeNull();
    // Slot is free — a follow-up attach succeeds.
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
    nextFakeForConnect = makeFakeCdp();
    const r2 = parseOkEnvelope<{ targetId: string }>(await attachNode.handler({}));
    expect(r2.targetId).toBe("n1");
  });

  it("close_session kills a launched Node child because lynceus owns it", async () => {
    const child = mockNodeInspectorStartup(makeFakeNodeChild(), 4567);
    cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);

    await launchNode.handler({ script: fixtureScript });
    const s = getSession()!;
    expect(s.ownedProcess).toEqual({ kind: "node", handle: child });
    expect(parseOkEnvelope(await closeSession.handler({}))).toBe("closed");
    expect(child.kill).toHaveBeenCalled();
    expect(s.client).toBeNull();
  });

  // SIGTERM → grace → SIGKILL escalation on owned Node children.
  // The current `close_session kills a launched Node child` test above uses
  // `makeFakeNodeChild`, whose mock kill() synchronously emits 'exit'. That
  // covers the graceful-shutdown happy path. These tests pin the additional
  // contract: a stubborn child gets SIGKILL'd after a grace window, an
  // already-exited child gets neither signal, and the call sequence is
  // SIGTERM-first regardless.
  describe("SIGTERM → SIGKILL escalation", () => {
    // A child that ignores signals by default — `kill()` returns true but
    // does NOT auto-emit 'exit'. Tests configure per-signal exit behavior
    // explicitly so the timing can be asserted against fake timers.
    function makeStubbornChild(pid = 8888) {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.pid = pid;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true); // base case: signal "sent", child stays alive
      return child;
    }

    it("graceful: child exits within grace window, only SIGTERM is sent", async () => {
      const child = makeStubbornChild();
      // Good citizen: respond to SIGTERM with a synchronous exit emission.
      child.kill = vi.fn((signal: NodeJS.Signals | number) => {
        if (signal === "SIGTERM") {
          child.exitCode = 0;
          child.emit("exit", 0, signal);
        }
        return true;
      });
      mockNodeInspectorStartup(child as any, 4567);
      cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
      await launchNode.handler({ script: fixtureScript });

      expect(parseOkEnvelope(await closeSession.handler({}))).toBe("closed");
      // Critical: ONLY SIGTERM — no escalation when the child is cooperative.
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("escalation: child ignores SIGTERM, SIGKILL fires after the grace window", async () => {
      const child = makeStubbornChild();
      // Stubborn: only SIGKILL terminates this child.
      child.kill = vi.fn((signal: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") {
          child.signalCode = "SIGKILL";
          child.emit("exit", null, signal);
        }
        return true;
      });
      mockNodeInspectorStartup(child as any, 4567);
      cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
      await launchNode.handler({ script: fixtureScript });

      // Fake timers ONLY during the close path — the launch arrangement above
      // depends on setImmediate firing for stderr-line emission, which is
      // covered by real timers.
      vi.useFakeTimers();
      try {
        const closePromise = closeSession.handler({});
        // Burn the 2000ms grace + 500ms post-SIGKILL wait. advanceTimersByTimeAsync
        // also drains the microtask queue at each step so the synchronous emit
        // inside kill("SIGKILL") propagates.
        await vi.advanceTimersByTimeAsync(2500);
        expect(parseOkEnvelope(await closePromise)).toBe("closed");
      } finally {
        vi.useRealTimers();
      }

      const signals = child.kill.mock.calls.map((c) => c[0]);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("idempotent: child has already exited — neither signal is sent", async () => {
      const child = makeStubbornChild();
      mockNodeInspectorStartup(child as any, 4567);
      cdpListMock.mockResolvedValue([{ id: "n1", type: "node", url: "" }]);
      await launchNode.handler({ script: fixtureScript });

      // Simulate the child exiting on its own between launch and close.
      child.exitCode = 0;

      expect(parseOkEnvelope(await closeSession.handler({}))).toBe("closed");
      expect(child.kill).not.toHaveBeenCalled();
    });
  });
});

describe("close_session", () => {
  it("returns 'no active session' (not an error) when no session exists", async () => {
    // Sentinel string — not an error envelope. The agent calling close
    // when nothing is open is a benign no-op, not a misuse.
    expect(parseOkEnvelope(await closeSession.handler({}))).toBe("no active session");
  });

  it("calls the session's close() and resets state when a session is active", async () => {
    const { session } = setupSession();
    expect(parseOkEnvelope(await closeSession.handler({}))).toBe("closed");
    // After close, the session's client is null again.
    expect(session.client).toBeNull();
  });
});

describe("list_targets", () => {
  it("no_session error", async () => {
    const r = await listTargets.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("no_session");
  });

  it("projects targets with active flag for the current target", async () => {
    const { session } = setupSession();
    session.currentTargetId = "page1";
    cdpListMock.mockResolvedValue([
      { id: "page1", type: "page", url: "http://x/", title: "Home" },
      { id: "page2", type: "page", url: "http://x/admin", title: "Admin" },
    ]);
    const r = parseOkEnvelope<any[]>(await listTargets.handler({}));
    expect(r).toEqual([
      { id: "page1", type: "page", url: "http://x/", title: "Home", active: true },
      { id: "page2", type: "page", url: "http://x/admin", title: "Admin", active: false },
    ]);
  });
});

describe("select_target", () => {
  it("no_session error", async () => {
    const r = await selectTarget.handler({ id: "t1" });
    expect(parseErrorEnvelope(r)?.error).toBe("no_session");
  });

  it("returns 'already-active' when id matches current target without reconnecting", async () => {
    const { session } = setupSession();
    session.currentTargetId = "page1";
    cdpListMock.mockClear();
    const r = parseOkEnvelope<{ id: string; status: string }>(
      await selectTarget.handler({ id: "page1" }),
    );
    expect(r).toEqual({ id: "page1", status: "already-active" });
    // Critical: should NOT have called CDP.List — that's the fast-path guard.
    expect(cdpListMock).not.toHaveBeenCalled();
  });

  it("failed reconnect frees the registry slot: a fresh attach recovers, never deadlocks (round-1 P1)", async () => {
    // Round-1 blocking finding: switchTarget nulls the client on an ACTIVE
    // record before reconnecting. When the reconnect failed, the record
    // survived active-but-clientless — invisible to close_session (client
    // sentinel) yet still counted by reserve(), so every follow-up
    // launch/attach returned already_session until the server restarted.
    const { session } = setupSession();
    session.currentTargetId = "page1";
    cdpListMock.mockResolvedValue([
      { id: "page1", type: "page", url: "http://x/" },
      { id: "page2", type: "page", url: "http://x/admin" },
    ]);
    const badFake = makeFakeCdp();
    badFake.respond("Debugger.enable", () => {
      throw new Error("target vanished mid-switch");
    });
    nextFakeForConnect = badFake;
    const failed = await selectTarget.handler({ id: "page2" });
    expect(parseErrorEnvelope(failed)).not.toBeNull();
    // The record must be gone, not wedged: accessors see no session AND the
    // capacity guard lets a fresh attach through.
    expect(getSession()).toBeNull();
    nextFakeForConnect = makeFakeCdp();
    const r = await attachChrome.handler({});
    expect(parseErrorEnvelope(r)).toBeNull();
  });
});

describe("registration metadata", () => {
  it("registers exactly the seven session tools (launch_node included)", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "attach_chrome",
      "attach_node",
      "close_session",
      "launch_chrome",
      "launch_node",
      "list_targets",
      "select_target",
    ]);
  });
});
