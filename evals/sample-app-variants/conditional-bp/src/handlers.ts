// conditional-bp variant: the bug only manifests once `count >= 2`
// (i.e., starting from the third click). First two clicks return
// `count + 1`; third and beyond return `count + 2`.
//
// The "elegant" approach is a conditional breakpoint on line 4 with
// condition `count >= 2`. The brute-force approach is clicking
// repeatedly and stepping until the wrong value appears.
export function increment(count: number): number {
  if (count >= 2) {
    return count + 2; // ← the conditional bug
  }
  return count + 1;
}
