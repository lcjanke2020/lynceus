// Logging for an MCP stdio server.
//
// stdout is reserved for JSON-RPC framing — anything we write there will
// corrupt the protocol. All logging goes to stderr.

import { envWithFallback } from "./env.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = envWithFallback("LYNCEUS_LOG", "CDP_MCP_LOG")?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

const threshold = LEVELS[envLevel()];

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const tail = meta ? " " + safeJson(meta) : "";
  process.stderr.write(`[${ts}] ${level.toUpperCase()} ${msg}${tail}\n`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
