// L1 unit tests for the SessionRegistry lifecycle invariants added by the
// PR 3 round-1 review: strict activation, re-entrant close awaiting the
// in-flight teardown, and closeAll error aggregation. The launch/close RACE
// coverage (through the real lifecycle entry points) lives in
// test/tools/session.test.ts; these pin the registry primitives directly.

import { describe, it, expect, afterEach } from "vitest";
import type CDP from "chrome-remote-interface";
import {
  registry,
  getSession,
  requireSession,
  ROOT_SESSION_KEY,
  type PreDocumentScriptRecord,
  type Session,
  type SessionKind,
} from "./state.js";
import { ToolError } from "../util/errors.js";

afterEach(() => {
  registry.resetForTests();
});

describe("SessionState pre-document scripts — isolation", () => {
  it("owns an independent registry per session and clears it on reset", () => {
    const browser = registry.reserve("browser");
    const node = registry.reserve("node");
    const script: PreDocumentScriptRecord = {
      id: "root-script",
      spec: Object.freeze({ source: "bootstrap();" }),
      installations: new Map([[ROOT_SESSION_KEY, "root-script"]]),
    };

    browser.state.preDocumentScripts.set(script.id, script);

    expect(browser.state.preDocumentScripts).not.toBe(node.state.preDocumentScripts);
    expect(browser.state.preDocumentScripts.get(script.id)).toBe(script);
    expect(node.state.preDocumentScripts.size).toBe(0);

    browser.state.reset();
    expect(browser.state.preDocumentScripts.size).toBe(0);
    expect(node.state.preDocumentScripts.size).toBe(0);
  });
});

describe("SessionRegistry.activate — strict starting → active invariant", () => {
  it("throws when the reservation was closed during startup (record deleted)", async () => {
    const rec = registry.reserve("browser");
    await registry.close(rec.id);
    expect(() => registry.activate(rec.id)).toThrow(/closed during startup/);
  });

  it("throws when the record is mid-close rather than flipping it back to active", async () => {
    const rec = registry.reserve("browser");
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.state.client = { close: () => blocker } as unknown as CDP.Client;
    const closing = registry.close(rec.id);
    expect(() => registry.activate(rec.id)).toThrow(/status is "closing"/);
    release();
    await closing;
    expect(getSession()).toBeNull();
  });
});

describe("SessionRegistry.close / closeAll — in-flight teardown is awaited", () => {
  it("re-entrant close(id) and closeAll() await the same in-flight teardown, never skip it", async () => {
    const rec = registry.reserve("node");
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    rec.state.client = { close: () => blocker } as unknown as CDP.Client;
    registry.activate(rec.id);

    let firstSettled = false;
    let reentrantSettled = false;
    let closeAllSettled = false;
    const first = registry.close(rec.id).then(() => {
      firstSettled = true;
    });
    const reentrant = registry.close(rec.id).then(() => {
      reentrantSettled = true;
    });
    const all = registry.closeAll().then(() => {
      closeAllSettled = true;
    });
    // Drain the microtask + immediate queues: with the client close still
    // blocked, none of the three may have settled — the round-1 gap was
    // exactly closeAll() returning while a close was still in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstSettled).toBe(false);
    expect(reentrantSettled).toBe(false);
    expect(closeAllSettled).toBe(false);

    release();
    await Promise.all([first, reentrant, all]);
    expect(getSession()).toBeNull();
  });

  it("abort() serializes with an in-flight teardown, then re-closes for post-teardown mutations", async () => {
    const rec = registry.reserve("node");
    registry.activate(rec.id);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closeCalls = 0;
    rec.state.close = (async () => {
      closeCalls += 1;
      if (closeCalls === 1) await blocker;
    }) as Session["close"];

    const inFlight = registry.close(rec.id);
    let abortSettled = false;
    const aborting = registry.abort(rec).then(() => {
      abortSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // While the first teardown is still in flight, abort must neither
    // re-enter close() concurrently nor settle.
    expect(closeCalls).toBe(1);
    expect(abortSettled).toBe(false);

    release();
    await Promise.all([inFlight, aborting]);
    // ...and it re-ran the close afterwards — the earlier teardown may
    // predate startup's last mutations.
    expect(closeCalls).toBe(2);
    expect(getSession()).toBeNull();
  });

  it("closeAll() aggregates a rejected close instead of masking it, and still drops the record", async () => {
    const rec = registry.reserve("node");
    registry.activate(rec.id);
    // SessionState.close() swallows its internal failures today, so reach
    // the aggregation path by stubbing the instance method directly.
    rec.state.close = (() => Promise.reject(new Error("teardown boom"))) as Session["close"];
    await expect(registry.closeAll()).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AggregateError && e.errors.some((inner) => String(inner).includes("teardown boom")),
    );
    expect(getSession()).toBeNull();
  });
});

// PR 4 (LEO-116 pt 3): the interim TOTAL capacity check becomes per-kind, labels
// are enforced, and the accessors + close path grow the §2 resolution
// (ambiguous_session / unknown_session) and the structured close result.
// Note: resetForTests() clears records but NOT the per-kind counters, so ids
// keep climbing across tests — assertions capture the minted id rather than
// pinning a literal "browser_1".
describe("SessionRegistry — per-kind capacity, labels, and §2 resolution", () => {
  function live(kind: SessionKind, label?: string) {
    const rec = registry.reserve(kind, label);
    rec.state.client = {} as unknown as CDP.Client; // truthy so getSession() sees it
    registry.activate(rec.id);
    return rec;
  }

  function thrown(fn: () => unknown): ToolError {
    try {
      fn();
    } catch (e) {
      return e as ToolError;
    }
    throw new Error("expected the call to throw");
  }

  it("a browser and a node session coexist (per-kind capacity)", () => {
    const b = live("browser", "frontend");
    const n = live("node", "backend");
    expect(registry.list().map((s) => s.session).sort()).toEqual([b.id, n.id].sort());
  });

  it("a second same-kind reservation throws already_session naming the incumbent", () => {
    const b = live("browser");
    const err = thrown(() => registry.reserve("browser"));
    expect(err.code).toBe("already_session");
    expect(err.message).toContain(b.id);
    expect(err.message).toContain("one session per kind");
  });

  it("a duplicate label — even across kinds — throws duplicate_label", () => {
    const b = live("browser", "frontend");
    const err = thrown(() => registry.reserve("node", "frontend"));
    expect(err.code).toBe("duplicate_label");
    expect(err.message).toContain(b.id);
  });

  it("ids are never recycled after a close", async () => {
    const first = live("node");
    await registry.close(first.id);
    const second = live("node");
    expect(second.id).not.toBe(first.id);
  });

  it("requireSession(): no session → no_session", () => {
    expect(thrown(() => requireSession()).code).toBe("no_session");
  });

  it("requireSession(): two live and no id → ambiguous_session listing both", () => {
    const b = live("browser", "frontend");
    const n = live("node", "backend");
    const err = thrown(() => requireSession());
    expect(err.code).toBe("ambiguous_session");
    expect(err.message).toContain(b.id);
    expect(err.message).toContain(n.id);
  });

  it("requireSession(): explicit unknown id → unknown_session", () => {
    live("browser");
    const err = thrown(() => requireSession("node_999"));
    expect(err.code).toBe("unknown_session");
    expect(err.message).toContain("node_999");
  });

  it("closeAddressed(): nothing live → idempotent no-active-session, never an error", async () => {
    await expect(registry.closeAddressed()).resolves.toEqual({
      session: null,
      label: null,
      status: "no-active-session",
    });
  });

  it("closeAddressed(id): returns the identity and tears the session down", async () => {
    const n = live("node", "backend");
    await expect(registry.closeAddressed(n.id)).resolves.toEqual({
      session: n.id,
      label: "backend",
      status: "closed",
    });
    expect(getSession()).toBeNull();
  });

  it("closeAddressed(): two live and no id → ambiguous_session", async () => {
    live("browser");
    live("node");
    await expect(registry.closeAddressed()).rejects.toMatchObject({ code: "ambiguous_session" });
  });

  it("closeAddressed(unknown id) → unknown_session", async () => {
    live("browser");
    await expect(registry.closeAddressed("node_999")).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("closeAddressed(id) is idempotent while the first close is in flight (not unknown_session)", async () => {
    // Review round 3 (Codex + Copilot): a "closing" record is still a real
    // session — a retried/concurrent explicit close must await the in-flight
    // teardown and report success, not unknown_session.
    const node = live("node", "backend");
    let release!: () => void;
    node.state.close = (async () => {
      await new Promise<void>((r) => (release = r));
    }) as Session["close"];
    const first = registry.closeAddressed(node.id); // flips the record to "closing", memoizes teardown
    const second = registry.closeAddressed(node.id); // retry during the in-flight close
    release();
    const expected = { session: node.id, label: "backend", status: "closed" };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
  });

  it("list(): reports id, kind, label, and the live flags", () => {
    const n = live("node", "backend");
    n.state.attached = true;
    n.state.url = "file:///app/index.js";
    expect(registry.list()).toEqual([
      { session: n.id, kind: "node", label: "backend", attached: true, paused: false, url: "file:///app/index.js" },
    ]);
  });

  // Review round 1 (P2): with per-kind capacity a second record is reachable,
  // so switchTarget's id-less cleanup could free the wrong session. It now uses
  // closeState(s), and id-less close() resolves the sole ACTIVE record.
  it("closeState() closes exactly the record owning the state, not the first-inserted one", async () => {
    const node = live("node"); // inserted first — the old id-less close() would pick this
    const browser = live("browser"); // inserted second — the record switchTarget holds
    await registry.closeState(browser.state);
    expect(registry.list().map((s) => s.session)).toEqual([node.id]);
  });

  it("closeState() frees the switchTarget record even while another session is mid-close", async () => {
    const node = live("node"); // inserted FIRST, about to be mid-teardown
    const browser = live("browser"); // the record switchTarget holds
    let releaseNode!: () => void;
    node.state.close = (async () => {
      await new Promise<void>((r) => (releaseNode = r));
    }) as Session["close"];
    void registry.close(node.id); // node → "closing", record lingers
    let browserClosed = false;
    const realClose = browser.state.close.bind(browser.state);
    browser.state.close = (async () => {
      browserClosed = true;
      await realClose();
    }) as Session["close"];
    browser.state.client = null; // switchTarget mid-swap
    await registry.closeState(browser.state);
    expect(browserClosed).toBe(true); // the browser WAS the one closed
    expect(registry.list()).toEqual([]); // nothing left wedged active
    releaseNode();
  });

  it("id-less close() resolves the sole ACTIVE record, skipping a not-yet-active one", async () => {
    registry.reserve("node"); // "starting", inserted FIRST, never activated
    live("browser"); // active, inserted second
    await registry.close(); // must close the browser, not the starting node
    expect(getSession()).toBeNull();
    // the starting node record survives — still blocks a fresh node reserve
    expect(thrown(() => registry.reserve("node")).code).toBe("already_session");
  });

  it("already_session says 'shutting down' (retry) for a closing incumbent, not 'close it'", async () => {
    const node = live("node");
    let release!: () => void;
    node.state.close = (async () => {
      await new Promise<void>((r) => (release = r));
    }) as Session["close"];
    void registry.close(node.id); // node → "closing"
    const err = thrown(() => registry.reserve("node"));
    expect(err.code).toBe("already_session");
    expect(err.message).toMatch(/shutting down/i);
    release();
  });
});
