// Tiny polling helper for L3 specs. Browser events (console, network,
// child-target attach) are asynchronous; rather than sprinkle setTimeout(N)
// guesses through every spec, wait for the actual condition and bail with a
// useful diagnostic if it never holds.

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
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined && v !== false) return v as T;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  const what = opts.describe ?? "condition";
  throw new Error(
    `waitFor: '${what}' did not hold within ${timeout}ms${lastErr ? `; last error: ${lastErr}` : ""}`,
  );
}
