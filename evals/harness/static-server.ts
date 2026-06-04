// Tiny port-0 static server for serving a scenario's sample-app variant.
//
// Functional twin of test/e2e/setup/static-server.ts — kept as a separate
// file rather than imported across the test/evals boundary because the
// L4 harness should ship without test/ as a dependency. If the two ever
// diverge in non-trivial ways, factor a shared lib.

import { createServer, type Server } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

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
      `static-server: root '${rootDir}' does not exist. Build the scenario variant first.`,
    );
  }
  // Normalize the root once — the per-request `startsWith(rootDir + sep)`
  // path-traversal check assumes a canonical absolute path with no
  // trailing separator. Caller-supplied relative paths or trailing
  // slashes would silently slip past the guard otherwise (PR #15 review).
  const root = resolve(rootDir);

  const server: Server = createServer((req, res) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const requested = urlPath === "/" ? "/index.html" : urlPath;
    const absolute = normalize(join(root, requested));
    if (!absolute.startsWith(root + sep) && absolute !== root) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let target = absolute;
    try {
      const st = statSync(target);
      if (st.isDirectory()) target = join(target, "index.html");
    } catch {
      /* 404 below */
    }
    if (!existsSync(target)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = extname(target).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    createReadStream(target).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
