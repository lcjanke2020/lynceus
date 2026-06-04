// Web Worker that "doubles" a value — except it doesn't. The bug is
// the multiplier (3 instead of 2). The agent needs to set a
// breakpoint inside worker.ts, drive the page to send a message,
// and pause in the WORKER's CDP session (not the root page's) to
// inspect the buggy multiplication.

interface DoubleMsg {
  kind: "double";
  count: number;
}

self.onmessage = (e: MessageEvent<DoubleMsg>) => {
  const result = doubleIt(e.data.count);
  self.postMessage(`doubled(${e.data.count}) = ${result}`);
};

function doubleIt(n: number): number {
  // THE BUG: should be `n * 2`. Off by a factor.
  return n * 3;
}
