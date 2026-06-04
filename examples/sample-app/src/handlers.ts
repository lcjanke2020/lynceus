// Buggy on purpose — used for the cdp-mcp end-to-end smoke test.
// A debugger run by an agent should land on line 12, inspect `count`,
// and figure out that the increment is wrong.

export function increment(count: number): number {
  const step = computeStep();
  const next = count + step;
  return next;
}

function computeStep(): number {
  return 2; // <-- the bug: should be 1
}
