// Tiny static server that serves examples/sample-app/dist on a random port.
//
// Why not `vite dev`: networkidle relies on the in-flight set being finite,
// but vite-dev keeps an HMR WebSocket open forever — the WS/EventSource
// skip in nav.ts already covers that for the page itself, but HMR also
// renames script IDs on every edit and that breaks source-map mapping for
// repeated specs. Plain static files. (Plan: L3 → Determinism → Sample-app
// spinup.)
//
// Why port 0: examples/sample-app/vite.config.ts has strictPort:true on 5173,
// which is fine for local dev but catastrophic in CI when another job already
// bound it. The static server doesn't share that config — it binds 0 and
// publishes the assigned port via process.env for the specs.

import { createServer, type Server } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { AddressInfo } from "node:net";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startStaticServer(rootDir: string): Promise<RunningServer> {
  if (!existsSync(rootDir)) {
    throw new Error(
      `static-server: root '${rootDir}' does not exist. Run 'npm run sample:build' first.`,
    );
  }
  const indexFile = join(rootDir, "index.html");
  if (!existsSync(indexFile)) {
    throw new Error(
      `static-server: '${indexFile}' missing. The sample-app build likely failed; check 'npm run sample:build'.`,
    );
  }

  const server: Server = createServer((req, res) => {
    // decodeURIComponent throws on malformed %XX sequences. Treat as 400
    // rather than letting the request handler crash (Opus PR #11 review
    // nit 7).
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    // SECURITY: reject any path that escapes rootDir after normalize.
    const requested = urlPath === "/" ? "/index.html" : urlPath;
    const absolute = normalize(join(rootDir, requested));
    if (!absolute.startsWith(rootDir + sep) && absolute !== rootDir) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let target = absolute;
    try {
      const st = statSync(target);
      if (st.isDirectory()) target = join(target, "index.html");
    } catch {
      // 404 below
    }
    if (!existsSync(target)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = extname(target).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      // Allow workers to import modules from the same origin without CORS
      // surprises. The default same-origin policy already covers this, but
      // explicit no-cache + COOP/COEP would be needed for SharedArrayBuffer
      // — sample-app doesn't use it.
      "Cache-Control": "no-cache",
    });
    createReadStream(target).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
