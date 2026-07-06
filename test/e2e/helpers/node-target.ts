// Spawn a real Node.js process under `--inspect-brk=127.0.0.1:0` for the L3
// Node-Inspector e2e spec. We bind to port 0 (not the default 9229) so a
// stale leftover process from a previously-crashed run can't block this one
// — vitest.e2e.config.ts runs L3 in singleFork + sequentially, but the
// suite has no graceful-shutdown story for a hung child between specs.
//
// Port discovery: Node prints `Debugger listening on ws://<host>:<port>/<uuid>`
// to stderr immediately after binding. We parse the line — deterministic and
// matches the manual-driver shape validated against Node
// v24.13.1. See docs/node-session-design.md §9 for the disk-backed-tsc
// contract this enables.

import { spawn } from "node:child_process";
import { join } from "node:path";

export interface InspectorTarget {
  port: number;
  /**
   * Terminate the child. Idempotent — safe to call from both the spec's
   * afterEach and a top-level catch path without double-kill warnings.
   */
  kill: () => void;
}

export const FIXTURE_DIR = join(
  process.cwd(),
  "examples",
  "sample-node-app",
  "dist",
);

const FIXTURE_ENTRY = join(FIXTURE_DIR, "index.js");

/**
 * Absolute path to a compiled sample-node-app entry script, e.g.
 * `fixtureScript("compute-step")` -> `.../sample-node-app/dist/compute-step.js`.
 * Use this in `launch_node`-driven L3 tests so each test can swap its
 * fixture by name without repeating the `join(cwd, examples, …)` chain.
 */
export function fixtureScript(name: string): string {
  return join(FIXTURE_DIR, `${name}.js`);
}

const LISTENING_RE = /^Debugger listening on ws:\/\/[^:]+:(\d+)\//m;

export async function spawnInspectorTarget(opts: {
  timeoutMs?: number;
} = {}): Promise<InspectorTarget> {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // --inspect-brk parks the V8 isolate at the first executable line — the
  // attach_node tool's Runtime.runIfWaitingForDebugger is what releases it
  // into the entry pause (design §7). --enable-source-maps is unnecessary
  // here (Node's flag only affects its OWN error-trace remapping; cdp-mcp's
  // loader is independent) but harmless and keeps stderr noise consistent
  // with how a user would actually run a TS-compiled app.
  const child = spawn(
    process.execPath,
    ["--inspect-brk=127.0.0.1:0", "--enable-source-maps", FIXTURE_ENTRY],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  };

  // Buffer stderr until we see the listening line, then resolve. If the
  // child exits or the deadline passes first, reject with whatever we got.
  return new Promise<InspectorTarget>((resolve, reject) => {
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      kill();
      reject(
        new Error(
          `spawnInspectorTarget: did not see 'Debugger listening' within ${timeoutMs}ms. stderr so far: ${stderrBuf || "(empty)"}`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBuf += chunk.toString("utf8");
      const m = LISTENING_RE.exec(stderrBuf);
      if (!m) return;
      const port = Number(m[1]);
      if (!Number.isFinite(port) || port <= 0) return;
      settled = true;
      clearTimeout(timer);
      resolve({ port, kill });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `spawnInspectorTarget: child exited before listening (code=${code}, signal=${signal}). stderr: ${stderrBuf || "(empty)"}`,
        ),
      );
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
