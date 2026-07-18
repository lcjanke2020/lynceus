// L1 unit tests for the SessionRegistry lifecycle invariants added by the
// PR 3 round-1 review: strict activation, re-entrant close awaiting the
// in-flight teardown, and closeAll error aggregation. The launch/close RACE
// coverage (through the real lifecycle entry points) lives in
// test/tools/session.test.ts; these pin the registry primitives directly.

import { describe, it, expect, afterEach } from "vitest";
import type CDP from "chrome-remote-interface";
import { registry, getSession, type Session } from "./state.js";

afterEach(() => {
  registry.resetForTests();
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
