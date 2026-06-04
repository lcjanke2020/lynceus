// network-bug variant: handlers.ts is clean. Bug is in main.ts (wrong
// fetch URL).
export function increment(count: number): number {
  return count + 1;
}
