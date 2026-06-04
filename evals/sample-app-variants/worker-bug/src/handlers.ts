// worker-bug variant: handlers.ts is clean. Bug is in worker.ts.
export function increment(count: number): number {
  return count + 1;
}
