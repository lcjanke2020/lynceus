import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;
const workerOut = document.getElementById("worker-out")!;

// Spawn a module worker that does the "real" computation. The bug
// lives inside worker.ts. main.ts just dispatches messages.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
worker.onmessage = (e) => {
  workerOut.textContent = `worker says: ${e.data}`;
};

btn.addEventListener("click", () => {
  count = increment(count);
  out.textContent = `count = ${count}`;
  // The worker's reply is what surfaces the bug — it should be
  // count * 2 but the worker computes count * 3.
  worker.postMessage({ kind: "double", count });
});
