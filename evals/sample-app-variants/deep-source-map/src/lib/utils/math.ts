// Nested helper — the agent's source-map suffix matcher
// (src/sourcemap/normalize.ts pathMatches) is what makes
// `set_breakpoint({file: "math.ts"})` resolve here even though the
// full source path is "lib/utils/math.ts" relative to src/.
export function add(a: number, b: number): number {
  // THE BUG: should return `a + b`. The extra `+ 1` makes increment()
  // add 2 each call instead of 1.
  return a + b + 1;
}
