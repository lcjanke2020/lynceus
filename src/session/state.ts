import type CDP from "chrome-remote-interface";
import type { LaunchedChrome } from "chrome-launcher";
import { PauseTracker } from "./pause.js";
import { RingBuffer, type ConsoleEntry, type NetworkEntry } from "./buffers.js";
import { ScriptStore } from "../sourcemap/store.js";
import { log } from "../util/log.js";
import { noSession, notPaused } from "../util/errors.js";

export interface BreakpointBinding {
  cdpId: string;
  sessionId?: string;
}

export interface BreakpointRecord {
  id: string; // user-facing id
  file: string;
  line: number;
  column?: number;
  condition?: string;
  logMessage?: string;
  resolvedLocations: Array<{ file: string; line: number; column: number }>;
  bindings: BreakpointBinding[];
}

export type HandlerEntry = { event: string; handler: (...args: any[]) => void };

const ROOT_SESSION_KEY = "__root__";
export { ROOT_SESSION_KEY };

class SessionState {
  client: CDP.Client | null = null;
  chrome: LaunchedChrome | null = null;
  chromePort: number | null = null;
  attached = false; // true when attached to a pre-existing chrome (don't kill on close)

  currentTargetId: string | null = null;
  currentSessionId: string | undefined = undefined; // for flat-session targets

  readonly pause = new PauseTracker();
  readonly console = new RingBuffer<ConsoleEntry>(1000);
  readonly network = new RingBuffer<NetworkEntry>(1000);
  readonly scripts = new ScriptStore();
  readonly breakpoints = new Map<string, BreakpointRecord>();
  // Per-session handler refs so we can removeListener on Target.detachedFromTarget.
  // Key is sessionId or ROOT_SESSION_KEY for the top-level target.
  readonly sessionHandlers = new Map<string, HandlerEntry[]>();
  // Last set_pause_on_exceptions state. Replayed to every newly-attached
  // child session in onChildAttached, so workers/iframes honor the setting
  // even when they attach after the user configured it.
  pauseOnExceptions: "none" | "uncaught" | "all" = "none";

  // Counter for generating user-friendly breakpoint IDs that survive resolve roundtrips.
  private bpCounter = 0;
  nextBpId(): string {
    this.bpCounter += 1;
    return `bp_${this.bpCounter}`;
  }

  reset() {
    this.client = null;
    this.chrome = null;
    this.chromePort = null;
    this.attached = false;
    this.currentTargetId = null;
    this.currentSessionId = undefined;
    this.pause.reset();
    this.console.clear();
    this.network.clear();
    this.scripts.clear();
    this.breakpoints.clear();
    this.sessionHandlers.clear();
    this.pauseOnExceptions = "none";
    this.bpCounter = 0;
  }

  async close(): Promise<void> {
    log.info("closing session");
    try {
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        if (this.chrome && !this.attached) {
          try {
            this.chrome.kill();
          } catch {
            /* ignore */
          }
        }
      } finally {
        this.reset();
      }
    }
  }
}

export const sessionState = new SessionState();

export function getSession(): SessionState | null {
  return sessionState.client ? sessionState : null;
}

export function requireSession(): SessionState {
  if (!sessionState.client) throw noSession();
  return sessionState;
}

export function requirePaused(): SessionState {
  const s = requireSession();
  if (!s.pause.isPaused()) throw notPaused();
  return s;
}

export type Session = SessionState;
