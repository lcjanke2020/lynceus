// event-binding variant: handlers.ts is FIXED here (no compute-step
// bug). The scenario's bug is isolated to main.ts (the typo'd event
// name), so the agent's investigation should land there.
export function increment(count: number): number {
  return count + 1;
}
