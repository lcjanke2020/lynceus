// Managed development-server subprocess for dual-target L4 scenarios.
//
// Browser-only scenarios use static-server.ts. The fullstack-cart fixture is
// deliberately Vite-development-only, so the dual target needs a real child
// process with readiness detection and process-tree cleanup. Keep this helper
// generic enough to unit-test with a tiny Node HTTP server; runner.ts supplies
// Vite's CLI as the default command shape.

import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const PROBE_TIMEOUT_MS = 500;
const STOP_GRACE_MS = 1_500;
const STOP_KILL_WAIT_MS = 500;
const MAX_DIAGNOSTIC_CHARS = 8_192;

export interface StartDevServerOpts {
  cwd: string;
  url: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

export interface RunningDevServer {
  url: string;
  pid: number | null;
  close(): Promise<void>;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export async function startDevServer(
  opts: StartDevServerOpts,
): Promise<RunningDevServer> {
  // Never mistake an unrelated process for the fixture we just launched.
  // Vite's strictPort would reject too, but this check produces the useful
  // error before spawning and avoids a fetch race against that other server.
  if (await responds(opts.url, false)) {
    throw new Error(
      `dev-server: '${opts.url}' is already responding; stop the process using that address before running this scenario.`,
    );
  }

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    // A separate POSIX process group lets cleanup terminate Vite and any
    // helper children (notably esbuild) together. Windows gets direct-child
    // termination; Vite tears its helpers down when its parent exits.
    detached: process.platform !== "win32",
  });

  let diagnostic = "";
  const capture = (chunk: Buffer | string): void => {
    diagnostic += chunk.toString();
    if (diagnostic.length > MAX_DIAGNOSTIC_CHARS) {
      diagnostic = diagnostic.slice(-MAX_DIAGNOSTIC_CHARS);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exitInfo: ExitInfo | null = null;
  let spawnError: Error | null = null;
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      // A failed spawn emits `error` without a corresponding `exit` event.
      // Resolve the cleanup wait as well as surfacing the original error.
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= stopChild(child, exited);
    return closePromise;
  };

  const deadline = Date.now() + (opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exitInfo) {
        throw new Error(
          `dev-server exited before '${opts.url}' became ready (${formatExit(exitInfo)}).${formatDiagnostic(diagnostic)}`,
        );
      }
      if (await responds(opts.url, true)) {
        return { url: opts.url, pid: child.pid ?? null, close };
      }
      await delay(READY_POLL_MS);
    }
    throw new Error(
      `dev-server timed out after ${opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS}ms waiting for '${opts.url}'.${formatDiagnostic(diagnostic)}`,
    );
  } catch (error) {
    await close();
    throw error;
  }
}

async function responds(url: string, requireOk: boolean): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return !requireOk || response.ok;
  } catch {
    return false;
  }
}

async function stopChild(
  child: ChildProcess,
  exited: Promise<ExitInfo>,
): Promise<void> {
  if (!isRunning(child)) return;
  signalProcessTree(child, "SIGTERM");
  await Promise.race([exited, delay(STOP_GRACE_MS)]);
  if (!isRunning(child)) return;
  signalProcessTree(child, "SIGKILL");
  await Promise.race([exited, delay(STOP_KILL_WAIT_MS)]);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between isRunning() and the signal.
  }
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function formatExit(exit: ExitInfo): string {
  return exit.signal ? `signal=${exit.signal}` : `code=${exit.code ?? "unknown"}`;
}

function formatDiagnostic(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `\nRecent output:\n${trimmed}` : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
