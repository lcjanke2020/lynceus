import { increment } from "./handlers.js";

let count = 0;
const out = document.getElementById("out")!;
const btn = document.getElementById("go")!;
const status = document.getElementById("status")!;

btn.addEventListener("click", async () => {
  // THE BUG: the endpoint URL is wrong — the static server doesn't
  // serve /api/wrong-endpoint, so fetch returns 404. The counter is
  // still updated locally (no early return on the failed fetch), so
  // the symptom is "status text says fetch failed" rather than "click
  // does nothing".
  try {
    const resp = await fetch("/api/wrong-endpoint");
    status.textContent = `fetch status: ${resp.status}`;
  } catch (e) {
    status.textContent = `fetch error: ${String(e)}`;
  }
  count = increment(count);
  out.textContent = `count = ${count}`;
});
