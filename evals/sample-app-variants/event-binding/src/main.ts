import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;

// THE BUG: addEventListener with a typo'd event name. The button still
// renders, but no listener is ever invoked.
btn.addEventListener("clik", () => {
  count = increment(count);
  out.textContent = `count = ${count}`;
});
