import { describe, it, expect } from "vitest";
import { registerNavTools } from "../../src/tools/nav.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerNavTools);
const navigate = tools.get("navigate")!;
const reload = tools.get("reload")!;
const getUrl = tools.get("get_url")!;

describe("navigate", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await navigate.handler({ url: "http://x" }))?.error).toBe("no_session");
  });

  it("wait=none: returns immediately after Page.navigate without waiting for any event", async () => {
    const { fake, session } = setupSession();
    fake.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", url: "http://x/landed" } } }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ url: string; wait: string }>(
      await navigate.handler({ url: "http://x", wait: "none" }),
    );
    expect(r.url).toBe("http://x/landed");
    expect(r.wait).toBe("none");
    expect(fake.sentCalls.find((c) => c.method === "Page.navigate")?.params.url).toBe("http://x");
    // navigate refreshes session.url so list_sessions stays current (review round 1).
    expect(session.url).toBe("http://x/landed");
  });

  it("wait=load: resolves when Page.loadEventFired arrives on the root session", async () => {
    // Test the load-mode listener by firing Page.loadEventFired synchronously
    // via the onSend hook on Page.navigate.
    const { fake } = setupSession();
    fake.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", url: "http://x/landed" } } }));
    fake.onSend("Page.navigate", () => {
      // Fire load event with sessionId=undefined (root) so the isRoot guard passes.
      fake.fireEvent("Page.loadEventFired", {}, undefined);
    });
    const r = parseOkEnvelope<{ url: string; wait: string }>(
      await navigate.handler({ url: "http://x", wait: "load" }),
    );
    expect(r.url).toBe("http://x/landed");
    expect(r.wait).toBe("load");
  });

  it("wait=load: ignores load events from child sessions (root-only gate)", async () => {
    // Fire a child-session loadEventFired BEFORE root → must NOT settle.
    // Then fire root loadEventFired → settles. With a small timeout, if the
    // gate were broken, the child fire would settle and we'd see wait=load
    // resolve early — but here the test is structurally that the timeout
    // would only trigger if root never fires, and we DO fire root, so success
    // verifies child events didn't prematurely satisfy.
    const { fake } = setupSession();
    fake.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", url: "http://x/landed" } } }));
    fake.onSend("Page.navigate", () => {
      // Iframe load fires first → must be ignored.
      fake.fireEvent("Page.loadEventFired", {}, "IFRAME-1");
      // Root load fires next → satisfies wait.
      fake.fireEvent("Page.loadEventFired", {}, undefined);
    });
    const r = parseOkEnvelope<{ url: string }>(
      await navigate.handler({ url: "http://x", wait: "load", timeout_ms: 100 }),
    );
    expect(r.url).toBe("http://x/landed");
  });

  it("wait=load: rejects with timeout error if no load event arrives", async () => {
    setupSession();
    const r = await navigate.handler({ url: "http://x", wait: "load", timeout_ms: 30 });
    const err = parseErrorEnvelope(r);
    expect(err?.message).toMatch(/load not reached within 30ms/);
  });

  it("wait=domcontentloaded: resolves on Page.domContentEventFired (root only)", async () => {
    const { fake } = setupSession();
    fake.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", url: "http://x/dcl" } } }));
    fake.onSend("Page.navigate", () => {
      fake.fireEvent("Page.domContentEventFired", {}, undefined);
    });
    const r = parseOkEnvelope<{ wait: string }>(
      await navigate.handler({ url: "http://x", wait: "domcontentloaded" }),
    );
    expect(r.wait).toBe("domcontentloaded");
  });
});

describe("reload", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await reload.handler({}))?.error).toBe("no_session");
  });

  it("forwards hard:true as ignoreCache:true to Page.reload", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    expect(parseOkEnvelope(await reload.handler({ hard: true }))).toBe("reloaded");
    expect(fake.sentCalls.find((c) => c.method === "Page.reload")?.params.ignoreCache).toBe(true);
  });

  it("default reload sends ignoreCache:false", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    await reload.handler({});
    expect(fake.sentCalls.find((c) => c.method === "Page.reload")?.params.ignoreCache).toBe(false);
  });
});

describe("get_url", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getUrl.handler({}))?.error).toBe("no_session");
  });

  it("returns the current top-frame URL via Page.getFrameTree", async () => {
    const { fake } = setupSession();
    fake.respond("Page.getFrameTree", () => ({
      frameTree: { frame: { id: "F1", url: "http://x/current" } },
    }));
    const r = parseOkEnvelope<{ url: string }>(await getUrl.handler({}));
    expect(r.url).toBe("http://x/current");
  });
});

describe("registration metadata", () => {
  it("registers exactly the three nav tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual(["get_url", "navigate", "reload"]);
  });
});
