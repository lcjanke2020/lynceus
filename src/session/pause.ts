import type { Protocol } from "devtools-protocol";

export interface PauseState {
  reason: Protocol.Debugger.PausedEvent["reason"];
  data?: object;
  hitBreakpoints?: string[];
  callFrames: Protocol.Debugger.CallFrame[];
  asyncStackTrace?: Protocol.Runtime.StackTrace;
  sessionId?: string;
  pausedAt: number;
}

type Waiter = {
  resolve: (state: PauseState) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
};

// Tracks one pause at a time. Callers wait via waitForPause(); the next
// Debugger.paused event resolves the pending waiter (or buffers state for a
// later call).
export class PauseTracker {
  private state: PauseState | null = null;
  private waiters: Waiter[] = [];

  current(): PauseState | null {
    return this.state;
  }

  isPaused(): boolean {
    return this.state !== null;
  }

  onPaused(state: PauseState) {
    this.state = state;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      w.resolve(state);
    }
  }

  onResumed() {
    this.state = null;
  }

  // Resolves on the next pause, or immediately if already paused.
  waitForPause(timeoutMs: number): Promise<PauseState> {
    if (this.state) return Promise.resolve(this.state);
    return new Promise<PauseState>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for pause`));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  // Used by step commands: resolve when either paused-again or resumed.
  //
  // Critical: check `this.state` at entry. The step path in tools/execution.ts
  // calls `onResumed()` (clearing state), then awaits `Debugger.stepOver` —
  // and for fast steps Chrome delivers the stepOver response and the
  // subsequent `Debugger.paused` in the same WebSocket batch. CRI emits
  // events synchronously, so `onPaused` runs *before* the awaiter resumes
  // and registers its waiter. Without this entry guard the pause is
  // buffered into nowhere, the waiter sits unresolved for `timeoutMs`,
  // and stepThen returns `{paused:false}` while `isPaused()` is actually
  // true — desync that misleads every subsequent pause-only tool.
  waitForPauseOrResume(timeoutMs: number): Promise<PauseState | null> {
    if (this.state) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onPause = (s: PauseState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(s);
      };
      const waiter: Waiter = {
        resolve: onPause,
        reject: (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
        timer: null,
      };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        // Treat timeout as "resumed without pausing" — common for short steps.
        resolve(null);
      }, timeoutMs);
    });
  }

  reset() {
    this.state = null;
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error("Session closed"));
    }
    this.waiters = [];
  }
}
