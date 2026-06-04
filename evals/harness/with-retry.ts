// Shared retry/backoff helper for vendor adapters (issue #63).
//
// Every adapter in this directory calls a model SDK / `fetch` exactly
// once per agent iteration. A single transient network blip (TypeError:
// fetch failed, ECONNRESET, a 503, a Vertex hiccup) used to propagate
// up and terminate the entire 24-trial eval run. Anthropic's SDK has
// been silently masking the issue on the Anthropic path with its own
// internal retries; OpenAI (Chat + Responses), Vertex, and LM Studio
// have no such cushion.
//
// `withRetry` wraps a per-iter model call with bounded exponential
// backoff + jitter. Zero deps; deliberately small surface:
//
//   - 3 attempts max (initial + 2 retries), backoff base [1s, 4s, 16s].
//   - Per-attempt sleep = base * (0.5 + Math.random())  ⇒ 50%–150%
//     jitter to avoid thundering-herd on a vendor-wide blip.
//   - Outer `timeoutMs` deadline. Pre-checked before each attempt and
//     before each sleep; if exceeded, the loop rethrows the last error
//     rather than retrying further. Sleeps are also clamped so they
//     can't extend past the deadline.
//   - 429 honoring: when the classifier extracts a `Retry-After`, the
//     backoff for that attempt uses it verbatim (clamped to the
//     deadline) instead of the jittered exponential.
//   - `onRetry` callback fires once per RETRIED attempt — i.e. NOT on
//     the final successful attempt. Adapter call sites pipe this
//     through `VendorMessageRequest.onRetry`; the runner attaches a
//     closure that writes an `AdapterRetryEntry` to the trace.
//     Exceptions thrown from `onRetry` are swallowed so a trace-write
//     failure can't kill the run.
//
// Classification is one polymorphic function (`classifyByVendor`) keyed
// off `Vendor`. The network-layer signals are identical across the four
// production adapters; only HTTP-status extraction differs (Anthropic
// SDK exposes `.status` on errors; raw-fetch adapters throw our own
// message-shaped errors with the status embedded; the @google/genai
// SDK's error surface is opaque so we string-match the status out of
// the message). Per-vendor classifiers would be four-way duplication of
// the same network checks; one polymorphic function is cleaner.

import type { Vendor } from "./vendor.js";

/** Per-attempt timeout sentinel for the Vertex adapter (the
 *  `@google/genai` SDK has no documented AbortSignal hook on
 *  `generateContent`, so we wrap the call in `Promise.race` against a
 *  setTimeout that rejects with this). Classified as retryable so a
 *  transient hang gets retried; the outer `timeoutMs` deadline ensures
 *  a true infinite hang can't retry forever. */
export class TimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
  /** If set, the next backoff uses this exact value (clamped to the
   *  deadline) instead of the jittered exponential. Populated by the
   *  classifier from a 429 `Retry-After` header. */
  retryAfterMs?: number;
}

export interface WithRetryOpts {
  vendor: Vendor;
  /** Outer deadline across all attempts + sleeps. When undefined the
   *  loop has no outer ceiling and falls back to whatever per-attempt
   *  timeout the adapter itself enforces (5 min default on every
   *  adapter today). */
  timeoutMs?: number;
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Invoked once per RETRIED attempt (not on the successful attempt).
   *  Receives the failing attempt's 1-indexed number, an error-summary
   *  string, and the realized jittered sleep about to happen before
   *  the next attempt. Exceptions are swallowed. */
  onRetry?: (e: { attempt: number; error: string; backoffMs: number }) => void;
  /** Test seam: inject a custom classifier. Production code uses
   *  `classifyByVendor(err, vendor)`. */
  classify?: (err: unknown) => RetryDecision;
  /** Test seam: inject a clock. Production code uses `Date.now`. */
  now?: () => number;
  /** Test seam: inject a sleeper. Production code uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: inject jitter [0, 1). Production code uses `Math.random`. */
  random?: () => number;
}

/** Backoff base per attempt: 1s before retry 2, 4s before retry 3, then
 *  16s for any further attempts (capped — `maxAttempts: 3` makes this
 *  effectively `[1000, 4000]` in production). */
const DEFAULT_BACKOFF_BASE_MS = [1000, 4000, 16000];

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOpts,
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const classify = opts.classify ?? ((err: unknown) => classifyByVendor(err, opts.vendor));
  // #63 review (PR #65, Copilot #4): clamp maxAttempts to ≥ 1 — a
  // bare `?? 3` would let a caller pass `0` or negative, the loop
  // would never run, and we'd `throw undefined` with `lastErr` unset.
  // Silent clamp beats throw-undefined: a caller passing 0/negative
  // is probably wrong, but the worst-case here (running once) is far
  // less debugging-hostile than the alternative.
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const startedAt = now();
  const deadline = opts.timeoutMs !== undefined ? startedAt + opts.timeoutMs : Infinity;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (now() >= deadline) {
      throw lastErr ?? new TimeoutError(
        `withRetry: deadline (${opts.timeoutMs} ms) reached before attempt ${attempt}`,
      );
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) throw err;
      const decision = classify(err);
      if (!decision.retry) throw err;
      const baseMs: number =
        DEFAULT_BACKOFF_BASE_MS[attempt - 1] ??
        DEFAULT_BACKOFF_BASE_MS[DEFAULT_BACKOFF_BASE_MS.length - 1]!;
      const jittered =
        decision.retryAfterMs ?? Math.round(baseMs * (0.5 + random()));
      const remaining = deadline - now();
      if (remaining <= 0) throw err;
      const backoffMs = Math.max(0, Math.min(jittered, remaining));
      if (opts.onRetry) {
        try {
          opts.onRetry({ attempt, error: errorMessage(err), backoffMs });
        } catch {
          // Trace-write failures must not kill the run.
        }
      }
      if (backoffMs > 0) await sleep(backoffMs);
    }
  }
  throw lastErr;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; cause?: { code?: string } };
    const code = e.code ?? e.cause?.code;
    return code ? `${err.name}: ${err.message} (${code})` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

const NETWORK_CAUSE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function isNetworkError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  const e = err as { code?: string; cause?: { code?: string }; name?: string };
  if (e.cause?.code && NETWORK_CAUSE_CODES.has(e.cause.code)) return true;
  if (e.code && NETWORK_CAUSE_CODES.has(e.code)) return true;
  return false;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") return true;
  return false;
}

/** Extract HTTP status from heterogeneous error shapes. Anthropic SDK
 *  errors carry `.status` directly. Our own raw-fetch adapters throw
 *  Error("OpenAI request failed: 503 …") — string-match the status
 *  out. Vertex SDK errors are opaque; same string-match approach. */
function extractStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number }; message?: string };
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  const msg = e.message ?? "";
  // Matches our adapter throw shapes:
  //   "OpenAI request failed: 500 …"
  //   "OpenAI Responses request failed: 503 …"
  //   "LM Studio request failed: 502 …"
  // and looser vendor strings like "[Vertex] 429 RESOURCE_EXHAUSTED".
  const m =
    /\b(?:request failed|status|HTTP)[^0-9]*(\d{3})\b/i.exec(msg) ??
    /\[[A-Za-z]+\]\s+(\d{3})\b/.exec(msg);
  if (m) return Number(m[1]);
  return undefined;
}

/** Try to pull a Retry-After value (in ms) from an error. Used only
 *  on 429s. Accepts both numeric-seconds and HTTP-date formats per
 *  RFC 7231 §7.1.3 (Copilot review #5 on PR #65); falls back to a
 *  regex against the message for our own embedded error strings. */
function extractRetryAfterMs(err: unknown): number | undefined {
  const e = err as {
    headers?: Record<string, string | undefined>;
    response?: { headers?: { get?: (k: string) => string | null } };
  };
  let header: string | null | undefined;
  if (e.response?.headers?.get) {
    header = e.response.headers.get("retry-after");
  }
  if (!header && e.headers) {
    header = e.headers["retry-after"] ?? e.headers["Retry-After"];
  }
  if (!header) {
    const msg = (err as Error).message ?? "";
    // \b after the digits prevents matching "Retry-After: 12abc" as 12.
    // Opus review #5 on PR #65 — low-likelihood since we control the
    // throw shapes, but the tighter form is the same cost.
    const m = /Retry-After[:\s]+(\d+(?:\.\d+)?)\b/i.exec(msg);
    if (m) header = m[1];
  }
  if (!header) return undefined;
  // Try numeric-seconds first (most common — OpenAI / Anthropic
  // emit this shape).
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // Fall back to HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
  // Some vendor proxies / WAFs emit dates instead of deltas.
  const epochMs = Date.parse(header);
  if (Number.isFinite(epochMs)) {
    const delta = epochMs - Date.now();
    if (delta >= 0) return delta;
  }
  return undefined;
}

/** Polymorphic, vendor-aware classifier.
 *
 *  Retryable: network errors (TypeError fetch failed, ECONN*, EAI_AGAIN,
 *  UND_ERR_*), AbortError (per-attempt timeout — outer deadline still
 *  bounds the loop), our own TimeoutError (Vertex Promise.race), 429
 *  (honoring Retry-After), HTTP 5xx.
 *
 *  Non-retryable: HTTP 4xx (≠ 429), anything we can't classify (safer
 *  to surface than to infinite-loop on a logic bug). */
export function classifyByVendor(err: unknown, vendor: Vendor): RetryDecision {
  void vendor; // reserved for future per-vendor branches
  if (isNetworkError(err)) return { retry: true, reason: "network" };
  if (isAbortError(err)) return { retry: true, reason: "abort" };
  const status = extractStatus(err);
  if (status === 429) {
    return { retry: true, reason: "429", retryAfterMs: extractRetryAfterMs(err) };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { retry: true, reason: String(status) };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { retry: false, reason: String(status) };
  }
  return { retry: false, reason: "unknown" };
}
