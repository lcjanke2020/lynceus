// Tiny polling helper for L3 specs. Browser + Node events (console, network,
// child-target attach, node output) are asynchronous; rather than sprinkle
// setTimeout(N) guesses through every spec, wait for the actual condition and
// bail with a useful diagnostic if it never holds.
//
// Convention: the polled fn returns null/undefined/false to mean "not ready,
// keep polling", and a truthy value once the condition holds. A THROW is a
// hard failure (e.g. a tool error envelope from `call()` — no_session, a bad
// argument) and propagates IMMEDIATELY; it is not retried. This keeps an early
// terminal failure from being masked behind the full timeout window (it would
// otherwise surface only as a generic "did not hold" after the deadline).

export interface WaitForOpts {
  timeoutMs?: number;
  intervalMs?: number;
  describe?: string;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  opts: WaitForOpts = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 5_000;
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // No try/catch: a thrown error is a real failure, not a "not ready"
    // signal (that is a null/undefined/false return), so let it propagate
    // with its original message/stack instead of swallowing it until timeout.
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, interval));
  }
  const what = opts.describe ?? "condition";
  throw new Error(`waitFor: '${what}' did not hold within ${timeout}ms`);
}
