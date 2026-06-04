import { increment } from "./handlers.js";

// Standard click-counter wiring — no bug here. The bug is in
// handlers.ts and conditional on count value.
let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;

btn.addEventListener("click", () => {
  count = increment(count);
  out.textContent = `count = ${count}`;
});
