import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;

btn.addEventListener("click", () => {
  count = increment(count);
  out.textContent = `count = ${count}`;
});
