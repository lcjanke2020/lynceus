import { describe, expect, it, vi } from "vitest";
import { classifyByVendor, TimeoutError, withRetry } from "./with-retry.js";

/** Synthetic clock + sleep so tests don't actually wait on timers. */
function makeClock() {
  let nowMs = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

describe("withRetry", () => {
  it("returns the value on first success, no sleep, no onRetry", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue("ok");
    const out = await withRetry(fn, {
      vendor: "anthropic",
      onRetry,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it("retries once on TypeError('fetch failed') then returns success", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");
    const out = await withRetry(fn, {
      vendor: "openai",
      onRetry,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5, // ⇒ jitter factor = 1.0
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({
      attempt: 1,
      backoffMs: 1000, // base[0]=1000 * (0.5 + 0.5) = 1000
    });
    expect(onRetry.mock.calls[0]![0].error).toMatch(/fetch failed/);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("exhausts maxAttempts and rethrows the last error", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    const err = new TypeError("fetch failed");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {
        vendor: "openai",
        onRetry,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2); // not called on final failed attempt
    expect(clock.sleeps).toEqual([1000, 4000]);
  });

  it("does NOT retry on HTTP 4xx (non-429)", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    const err = new Error("OpenAI request failed: 401 Unauthorized — bad key");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {
        vendor: "openai",
        onRetry,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it("retries on 5xx", async () => {
    const clock = makeClock();
    const err = new Error("OpenAI request failed: 503 Service Unavailable");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const out = await withRetry(fn, {
      vendor: "openai",
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("honors Retry-After on 429 (in seconds, applied verbatim)", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    // Error message carries Retry-After: 2 — the classifier extracts
    // 2000 ms which the backoff layer uses unmodified.
    const err = new Error("OpenAI request failed: 429 Too Many — Retry-After: 2");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const out = await withRetry(fn, {
      vendor: "openai",
      onRetry,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.99, // would normally jitter ~1500ms — proves Retry-After wins
    });
    expect(out).toBe("ok");
    expect(clock.sleeps).toEqual([2000]);
    expect(onRetry.mock.calls[0]![0].backoffMs).toBe(2000);
  });

  it("outer timeoutMs deadline forces early bailout — no sleep past deadline", async () => {
    const clock = makeClock();
    const onRetry = vi.fn();
    const err = new TypeError("fetch failed");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, {
        vendor: "vertex",
        timeoutMs: 500, // < first backoff base of 1000
        onRetry,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0.5,
      }),
    ).rejects.toBe(err);
    // First attempt runs, then deadline (now=1_000_500) is reached
    // before a 1000 ms sleep could complete — sleep is clamped to the
    // remaining 500 ms, but `now() >= deadline` after the sleep means
    // we throw without re-attempting.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([500]);
  });

  it("jitter stays in [0.5, 1.5] × base across 100 samples", async () => {
    // Drive 100 single-retry runs with random()=u where u sweeps [0,1).
    for (let i = 0; i < 100; i++) {
      const clock = makeClock();
      const u = i / 100;
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce("ok");
      await withRetry(fn, {
        vendor: "anthropic",
        now: clock.now,
        sleep: clock.sleep,
        random: () => u,
      });
      expect(clock.sleeps).toHaveLength(1);
      const slept = clock.sleeps[0]!;
      expect(slept).toBeGreaterThanOrEqual(500); // 1000 * 0.5
      expect(slept).toBeLessThanOrEqual(1500); // 1000 * 1.5
    }
  });

  it("swallows exceptions thrown from onRetry (trace-write failures don't kill the run)", async () => {
    const clock = makeClock();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn(() => {
      throw new Error("disk full");
    });
    const out = await withRetry(fn, {
      vendor: "anthropic",
      onRetry,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });
    expect(out).toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("clamps maxAttempts<1 to 1 (Copilot #4 on PR #65) — no throw undefined on bad input", async () => {
    const clock = makeClock();
    const fn = vi.fn().mockResolvedValue("ok");
    // maxAttempts=0 used to make the loop body never run and then
    // `throw lastErr` with lastErr=undefined — surface as `throw
    // undefined`, which is debugging-hostile. Now clamps to 1.
    const out = await withRetry(fn, {
      vendor: "anthropic",
      maxAttempts: 0,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("classifies TimeoutError (Vertex Promise.race wrapper) as retryable", async () => {
    const clock = makeClock();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TimeoutError("vertex: per-attempt timeout"))
      .mockResolvedValueOnce("ok");
    const out = await withRetry(fn, {
      vendor: "vertex",
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("classifyByVendor", () => {
  it("treats Node fetch-failed TypeError as retryable", () => {
    const d = classifyByVendor(new TypeError("fetch failed"), "openai");
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("network");
  });

  it("treats error.cause.code=ECONNRESET as retryable", () => {
    const err = Object.assign(new Error("socket hang up"), {
      cause: { code: "ECONNRESET" },
    });
    expect(classifyByVendor(err, "openai")).toMatchObject({ retry: true });
  });

  it("treats Vertex string-shaped 503 as retryable", () => {
    const err = new Error("[Vertex] 503 Service Unavailable");
    const d = classifyByVendor(err, "vertex");
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("503");
  });

  it("treats Anthropic SDK-style { status: 429 } as retryable with Retry-After", () => {
    const err = Object.assign(new Error("rate limited — Retry-After: 5"), {
      status: 429,
    });
    const d = classifyByVendor(err, "anthropic");
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("429");
    expect(d.retryAfterMs).toBe(5000);
  });

  it("parses HTTP-date Retry-After (Copilot #5 on PR #65) — vendor proxies sometimes send dates", () => {
    const futureMs = Date.now() + 4_000;
    const httpDate = new Date(futureMs).toUTCString();
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": httpDate },
    });
    const d = classifyByVendor(err, "openai");
    expect(d.retry).toBe(true);
    expect(d.reason).toBe("429");
    // Delta within 100 ms of 4_000 (test clock skew). HTTP-date
    // resolution is 1 second so we tolerate up to 1500ms drift.
    expect(d.retryAfterMs).toBeGreaterThanOrEqual(2500);
    expect(d.retryAfterMs).toBeLessThanOrEqual(4500);
  });

  it("treats 4xx (≠ 429) as non-retryable", () => {
    expect(
      classifyByVendor(
        new Error("OpenAI request failed: 400 Bad Request"),
        "openai",
      ),
    ).toMatchObject({ retry: false });
    expect(
      classifyByVendor(Object.assign(new Error("nope"), { status: 401 }), "anthropic"),
    ).toMatchObject({ retry: false });
  });

  it("returns retry:false for unknown errors (safer than infinite-loop on a logic bug)", () => {
    expect(
      classifyByVendor(new Error("something bizarre"), "openai"),
    ).toMatchObject({ retry: false, reason: "unknown" });
  });
});
