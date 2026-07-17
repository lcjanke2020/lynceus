import express from "express";
import { cartRouter } from "./cart.js";

const app = express();

// The Vite dev server is a different origin, so the browser preflights the
// JSON POST — answer CORS for the dev origin (override with CORS_ORIGIN).
const devOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", devOrigin);
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
