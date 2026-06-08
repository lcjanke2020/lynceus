import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;
const workerOut = document.getElementById("worker-out")!;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const nameEcho = document.getElementById("name-echo")!;

// Spawn a Web Worker. It runs in its own session — the L3 worker spec
// asserts list_targets enumerates it and pause(session_id) routes to it.
// The worker is harmless here; L4's worker-bug scenario forks this app
// and gives the worker a buggy computation instead.
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.onmessage = (e) => {
  workerOut.textContent = `worker: ${e.data}`;
};
worker.postMessage({ kind: "init" });

btn.addEventListener("click", () => {
  count = increment(count);
  out.textContent = `count = ${count}`;
  console.log("clicked, count is now", count);
  worker.postMessage({ kind: "compute", count });
});

nameInput.addEventListener("input", () => {
  nameEcho.textContent = `name: ${nameInput.value || "(empty)"}`;
});

// Form controls for the L3 form-driving spec (select_option / check / fill).
// Each echoes on `change` so the spec can confirm the tool dispatched the
// framework-observable event, not just mutated the property.
const subscribe = document.getElementById("subscribe") as HTMLInputElement;
const subscribeEcho = document.getElementById("subscribe-echo")!;
subscribe.addEventListener("change", () => {
  subscribeEcho.textContent = `subscribe: ${subscribe.checked}`;
});

const fruit = document.getElementById("fruit") as HTMLSelectElement;
const fruitEcho = document.getElementById("fruit-echo")!;
fruit.addEventListener("change", () => {
  fruitEcho.textContent = `fruit: ${fruit.value}`;
});

// Multi-select for the L3 select_option(multiple:true) coverage. Echoes the
// full set of selected values on `change`. Null-guarded so sample-app variants
// that omit this control still build/run.
const fruitsMulti = document.getElementById("fruits-multi") as HTMLSelectElement | null;
const fruitsMultiEcho = document.getElementById("fruits-multi-echo");
if (fruitsMulti && fruitsMultiEcho) {
  fruitsMulti.addEventListener("change", () => {
    const picked = Array.from(fruitsMulti.selectedOptions).map((o) => o.value);
    fruitsMultiEcho.textContent = `fruits-multi: ${picked.join(",")}`;
  });
}
