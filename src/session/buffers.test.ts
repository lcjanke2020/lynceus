import { describe, it, expect } from "vitest";
import { RingBuffer, type ConsoleEntry } from "./buffers.js";

describe("RingBuffer", () => {
  it("assigns monotonic seq and supports `since` pagination", () => {
    const buf = new RingBuffer<ConsoleEntry>(100);
    buf.push({ ts: 1, level: "log", text: "a", source: "console-api" } as Omit<ConsoleEntry, "seq">);
    buf.push({ ts: 2, level: "log", text: "b", source: "console-api" } as Omit<ConsoleEntry, "seq">);
    buf.push({ ts: 3, level: "log", text: "c", source: "console-api" } as Omit<ConsoleEntry, "seq">);
    const all = buf.query();
    expect(all.map((e) => [e.seq, e.text])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
    const after1 = buf.query({ since: 1 });
    expect(after1.map((e) => e.text)).toEqual(["b", "c"]);
  });

  it("filters and limits", () => {
    const buf = new RingBuffer<ConsoleEntry>(100);
    for (const text of ["alpha", "bravo", "charlie", "delta"]) {
      buf.push({ ts: 0, level: "log", text, source: "console-api" } as Omit<ConsoleEntry, "seq">);
    }
    const matched = buf.query({ filter: (e) => e.text.startsWith("b") });
    expect(matched.map((e) => e.text)).toEqual(["bravo"]);
    const limited = buf.query({ limit: 2 });
    expect(limited.map((e) => e.text)).toEqual(["charlie", "delta"]);
  });

  it("drops oldest when capacity is exceeded", () => {
    const buf = new RingBuffer<ConsoleEntry>(3);
    for (let i = 0; i < 5; i++) {
      buf.push({ ts: 0, level: "log", text: `m${i}`, source: "console-api" } as Omit<ConsoleEntry, "seq">);
    }
    const items = buf.query();
    expect(items.map((e) => e.text)).toEqual(["m2", "m3", "m4"]);
    // seq still monotonic across drops
    expect(items.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("update mutates the most recent matching entry", () => {
    const buf = new RingBuffer<{ seq: number; key: string; v?: number }>(10);
    buf.push({ key: "a" });
    buf.push({ key: "b" });
    buf.push({ key: "a" });
    const updated = buf.update((e) => e.key === "a", { v: 42 });
    expect(updated?.v).toBe(42);
    const stillA = buf.query({ filter: (e) => e.key === "a" });
    expect(stillA.map((e) => e.v)).toEqual([undefined, 42]);
  });

  it("update on an empty buffer returns null without throwing", () => {
    // The Network handler can fire responseReceived for a request whose
    // requestWillBeSent was dropped (e.g. service-worker preloads when
    // the buffer is full). update() must handle the no-match case.
    const buf = new RingBuffer<{ seq: number; key: string }>(10);
    expect(buf.update(() => true, { key: "x" })).toBeNull();
  });

  it("update returns null when no entry matches the predicate", () => {
    const buf = new RingBuffer<{ seq: number; key: string }>(10);
    buf.push({ key: "a" });
    buf.push({ key: "b" });
    expect(buf.update((e) => e.key === "missing", { key: "x" })).toBeNull();
  });

  it("query with `since` past nextSeq returns []", () => {
    const buf = new RingBuffer<{ seq: number; key: string }>(10);
    buf.push({ key: "a" });
    buf.push({ key: "b" });
    // Caller asks "anything after seq 99?" but only 2 items exist.
    expect(buf.query({ since: 99 })).toEqual([]);
    // Boundary: since === last seq returns nothing (strictly greater).
    expect(buf.query({ since: 2 })).toEqual([]);
  });

  it("seq is monotonic across capacity-boundary updates", () => {
    // Regression guard: update() must not reset seq numbering. A naive
    // implementation that re-pushes the updated entry would mint a fresh
    // seq, breaking client-side `since` cursors.
    const buf = new RingBuffer<{ seq: number; key: string; v?: number }>(3);
    buf.push({ key: "a" });
    buf.push({ key: "b" });
    buf.push({ key: "c" });
    const beforeUpdate = buf.query().map((e) => e.seq);
    expect(beforeUpdate).toEqual([1, 2, 3]);
    buf.update((e) => e.key === "b", { v: 99 });
    // Seqs unchanged — update mutates in place, doesn't re-push.
    expect(buf.query().map((e) => e.seq)).toEqual([1, 2, 3]);
    // Pushing past capacity continues from nextSeq, not from a recycled value.
    buf.push({ key: "d" });
    buf.push({ key: "e" });
    const after = buf.query();
    expect(after.map((e) => e.seq)).toEqual([3, 4, 5]);
    // The "b" entry was dropped to make room — its seq=2 is gone forever.
    expect(after.map((e) => e.key)).toEqual(["c", "d", "e"]);
  });
});
