import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;

btn.addEventListener("click", () => {
  // THE BUG: read a property off an element that doesn't exist in the
  // DOM. The querySelector returns null, the property access throws
  // TypeError, the counter never updates, the error shows up in the
  // page's console.
  const missing = document.getElementById("does-not-exist");
  missing!.textContent = "ok"; // TypeError: Cannot set properties of null
  count = increment(count);
  out.textContent = `count = ${count}`;
});
