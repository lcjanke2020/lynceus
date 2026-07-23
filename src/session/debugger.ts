import type CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";
import { registerHandler, type Session } from "./state.js";
import { buildScriptParsedHandler } from "../sourcemap/loader.js";
import { mapCdpToOriginal } from "../sourcemap/store.js";
import { previewRemoteObject } from "../util/format.js";
import { log } from "../util/log.js";

// Target-agnostic debugger setup shared between browser and Node sessions.
// Wires the five Runtime+Debugger event handlers and enables the two
// domains. Browser-specific concerns (Page/DOM/Network enable + network
// ring-buffer wiring) stay in src/session/browser.ts.
export async function connectDebugger(
  session: Session,
  client: CDP.Client,
  sessionId: string | undefined,
): Promise<void> {
  // Strict same-session gate. The original "if (sessionId && eventSessionId
  // !== sessionId)" form was vacuously false when sessionId=undefined, so
  // the root handler processed every child's events.
  const own = (eventSessionId: string | undefined) => eventSessionId === sessionId;

  registerHandler(
    session,
    client,
    sessionId,
    "Debugger.scriptParsed",
    buildScriptParsedHandler(session, sessionId),
  );

  registerHandler(session, client, sessionId, "Debugger.paused", (
    params: Protocol.Debugger.PausedEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    session.pause.onPaused({
      // Node emits non-Chromium reason strings (empirically "Break on start"
      // for --inspect-brk); keep this as the raw string and let callers
      // drive off hitBreakpoints, not reason.
      reason: params.reason,
      data: params.data,
      hitBreakpoints: params.hitBreakpoints,
      callFrames: params.callFrames,
      asyncStackTrace: params.asyncStackTrace,
      sessionId: eventSessionId,
      pausedAt: Date.now(),
    });
    log.debug("paused", { reason: params.reason, hit: params.hitBreakpoints });
  });

  registerHandler(session, client, sessionId, "Debugger.resumed", (
    _p: unknown,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    session.pause.onResumed();
  });

  registerHandler(session, client, sessionId, "Runtime.consoleAPICalled", (
    params: Protocol.Runtime.ConsoleAPICalledEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    pushConsoleFromApi(session, params, eventSessionId);
  });

  registerHandler(session, client, sessionId, "Runtime.exceptionThrown", (
    params: Protocol.Runtime.ExceptionThrownEvent,
    eventSessionId?: string,
  ) => {
    if (!own(eventSessionId)) return;
    pushConsoleFromException(session, params, eventSessionId);
  });

  // Runtime + Debugger are the load-bearing common denominator for both
  // browser and Node sessions — without them no breakpoints, no entry pause,
  // no scriptParsed. Let failures surface so the caller can tear the
  // partially-initialized session down rather than report success on a
  // broken half-attached state. (Ultrareview round 2 — Codex Medium #1.)
  // Browser-only Page/DOM/Network stay best-effort over in enableBrowserDomains.
  await client.Runtime.enable(sessionId);
  await client.Debugger.enable({}, sessionId);
}

function pushConsoleFromApi(
  s: Session,
  params: Protocol.Runtime.ConsoleAPICalledEvent,
  sessionId: string | undefined,
) {
  // Two formatting modes:
  //   - String args render as raw text (no surrounding quotes, no \n→\\n
  //     escapes) — matches how DevTools / Node / every log shipper renders
  //     console.log("Server started"). previewRemoteObject would
  //     JSON.stringify them, which is right for REPL/evaluate output but
  //     wrong for console buffering.
  //   - Everything else (numbers, objects, arrays, functions, …) goes
  //     through previewRemoteObject so {foo:1} keeps its shape.
  const renderArg = (a: Protocol.Runtime.RemoteObject) =>
    a.type === "string" ? (a.value ?? "") : previewRemoteObject(a);
  const text =
    params.args.length === 0
      ? "(no args)"
      : params.args.map(renderArg).join(" ");
  const top = params.stackTrace?.callFrames?.[0];
  const mapped = top
    ? mapCdpToOriginal(
        s.scripts,
        { scriptId: top.scriptId, lineNumber: top.lineNumber, columnNumber: top.columnNumber },
        sessionId,
      )
    : null;
  s.console.push({
    ts: Date.now(),
    level: mapApiLevel(params.type),
    text,
    source: "console-api",
    ...(top?.url ? { url: top.url } : {}),
    ...(top ? { lineNumber: top.lineNumber, columnNumber: top.columnNumber } : {}),
    ...(mapped ? { mappedFile: mapped.file, mappedLine: mapped.line, mappedColumn: mapped.column } : {}),
    ...(params.stackTrace ? { stack: params.stackTrace } : {}),
  });
}

function pushConsoleFromException(
  s: Session,
  params: Protocol.Runtime.ExceptionThrownEvent,
  sessionId: string | undefined,
) {
  const det = params.exceptionDetails;
  const top = det.stackTrace?.callFrames?.[0];
  const mapped = top
    ? mapCdpToOriginal(
        s.scripts,
        { scriptId: top.scriptId, lineNumber: top.lineNumber, columnNumber: top.columnNumber },
        sessionId,
      )
    : null;
  const text = (det.exception?.description ?? det.exception?.value ?? det.text) + "";
  s.console.push({
    ts: Date.now(),
    level: "error",
    text,
    source: "runtime-exception",
    ...(top?.url ? { url: top.url } : { url: det.url }),
    ...(top
      ? { lineNumber: top.lineNumber, columnNumber: top.columnNumber }
      : { lineNumber: det.lineNumber, columnNumber: det.columnNumber }),
    ...(mapped ? { mappedFile: mapped.file, mappedLine: mapped.line, mappedColumn: mapped.column } : {}),
    ...(det.stackTrace ? { stack: det.stackTrace } : {}),
  });
}

function mapApiLevel(
  t: Protocol.Runtime.ConsoleAPICalledEvent["type"],
): import("./buffers.js").ConsoleEntry["level"] {
  switch (t) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "trace":
      return "trace";
    case "log":
    default:
      return "log";
  }
}
