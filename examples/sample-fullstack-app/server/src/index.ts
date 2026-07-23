import express from "express";
import { cartRouter } from "./cart.js";

const app = express();

// The Vite dev server is a different origin, so the browser preflights the
// JSON POST. Both loopback spellings of the dev origin are allowed — a page
// opened as 127.0.0.1:5173 instead of localhost:5173 would otherwise fail
// CORS and masquerade as a backend bug, mid-demo (override with CORS_ORIGIN).
const allowedOrigins = process.env.CORS_ORIGIN
  ? [process.env.CORS_ORIGIN]
  : ["http://localhost:5173", "http://127.0.0.1:5173"];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin !== undefined && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(cartRouter);

app.use(express.json());

// PORT=0 asks the OS for a free port; the actual port is printed to stdout
// so callers can parse it (same convention the e2e fixtures use). The
// frontend defaults to :3001 — set VITE_API_URL if you change this.
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual =
    typeof address === "object" && address !== null ? address.port : port;
  console.log(
    `sample-fullstack-app api listening on http://127.0.0.1:${actual}`,
  );
});
