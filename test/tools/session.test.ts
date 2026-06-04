import { describe, it, expect, vi, beforeEach } from "vitest";
import { sessionState } from "../../src/session/state.js";
import { makeFakeCdp, type FakeCdp } from "../fake-cdp.js";

// IMPLEMENTATION NOTE (Opus PR #10 round-2 Nit): this file uses `vi.mock`
// to stub chrome-launcher and chrome-remote-interface, deliberately
// breaking the unified `sessionState.client = fake` seam pattern that
// every other tool-test file uses. Reason: chrome-launcher's `launch()`
// and chrome-remote-interface's default export + `.List` are STATIC
// imports — they're resolved at module-load time, before sessionState
// even exists. There's no runtime seam to redirect them through; only
// vitest's module mocking can intercept them. Don't try to "unify the
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

// Imports MUST come after vi.mock so the registrar sees the mocked modules.
import { registerSessionTools } from "../../src/tools/session.js";
import { autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerSessionTools);
const launchChrome = tools.get("launch_chrome")!;
const attachChrome = tools.get("attach_chrome")!;
const closeSession = tools.get("close_session")!;
const listTargets = tools.get("list_targets")!;
const selectTarget = tools.get("select_target")!;

beforeEach(() => {
  launchMock.mockReset();
  cdpListMock.mockReset();
  mkdirSyncMock.mockReset();
  delete process.env.CHROME_PATH;
  nextFakeForConnect = makeFakeCdp();
});

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
    expect(call?.userDataDir).toMatch(/[/\\]snap[/\\]chromium[/\\]current[/\\]cdp-mcp-test-profile$/);
    // mkdirSync(udd, { recursive: true }) ran so the dir exists before chrome
    // tries to write its first-run lock + chrome-out.log into it. (Issue #13.)
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]snap[/\\]chromium[/\\]current[/\\]cdp-mcp-test-profile$/),
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
    expect(call?.userDataDir).toMatch(/[/\\]snap[/\\]chromium[/\\]current[/\\]cdp-mcp-test-profile$/);
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

  it("already_session error when a session is already active", async () => {
    sessionState.client = makeFakeCdp() as any;
    sessionState.chromePort = 9999;
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
    sessionState.client = makeFakeCdp() as any;
    const r = await attachChrome.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("already_session");
  });
});

describe("close_session", () => {
  it("returns 'no active session' (not an error) when no session exists", async () => {
    // Sentinel string — not an error envelope. The agent calling close
    // when nothing is open is a benign no-op, not a misuse.
    expect(parseOkEnvelope(await closeSession.handler({}))).toBe("no active session");
  });

  it("calls sessionState.close() and resets state when a session is active", async () => {
    const fake = makeFakeCdp();
    sessionState.client = fake as any;
    sessionState.chromePort = 9999;
    expect(parseOkEnvelope(await closeSession.handler({}))).toBe("closed");
    // After close, sessionState.client is null again.
    expect(sessionState.client).toBeNull();
  });
});

describe("list_targets", () => {
  it("no_session error", async () => {
    const r = await listTargets.handler({});
    expect(parseErrorEnvelope(r)?.error).toBe("no_session");
  });

  it("projects targets with active flag for the current target", async () => {
    sessionState.client = makeFakeCdp() as any;
    sessionState.chromePort = 9999;
    sessionState.currentTargetId = "page1";
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
    sessionState.client = makeFakeCdp() as any;
    sessionState.currentTargetId = "page1";
    sessionState.chromePort = 9999;
    cdpListMock.mockClear();
    const r = parseOkEnvelope<{ id: string; status: string }>(
      await selectTarget.handler({ id: "page1" }),
    );
    expect(r).toEqual({ id: "page1", status: "already-active" });
    // Critical: should NOT have called CDP.List — that's the fast-path guard.
    expect(cdpListMock).not.toHaveBeenCalled();
  });
});

describe("registration metadata", () => {
  it("registers exactly the five session tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "attach_chrome",
      "close_session",
      "launch_chrome",
      "list_targets",
      "select_target",
    ]);
  });
});
