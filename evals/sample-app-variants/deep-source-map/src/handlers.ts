// deep-source-map variant: handlers.ts is the call-through layer; the
// actual bug is in src/lib/utils/math.ts (the dependency). Exists
// here unchanged from a typical real app — the agent has to follow
// the import chain to find the bug.
import { add } from "./lib/utils/math.js";

export function increment(count: number): number {
  return add(count, 1);
}
