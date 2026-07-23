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

export interface PauseWaitHandle {
  promise: Promise<PauseState>;
  cancel: () => void;
}

export class PauseTrackerClosedError extends Error {
  constructor() {
    super("Session closed");
    this.name = "PauseTrackerClosedError";
  }
}

type ResumeWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

// Tracks one pause at a time. Callers wait via waitForPause(); the next
// Debugger.paused event resolves the pending waiter (or buffers state for a
// later call).
export class PauseTracker {
  private state: PauseState | null = null;
  private waiters: Waiter[] = [];
  private resumeWaiters: ResumeWaiter[] = [];

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
    while (this.resumeWaiters.length) {
      const w = this.resumeWaiters.shift()!;
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  // Resolves the next time Debugger.resumed fires (via onResumed). Used by
  // the `resume` tool to block until PauseTracker.state has actually cleared
  // before returning — without this gap, an immediate follow-up
  // wait_for_pause hits the sticky pre-resume state in waitForPause and
  // returns the stale pause as if nothing happened. (Resume/resumed race 1.)
  //
  // The listener MUST be registered before Debugger.resume is sent: CRI
  // emits events synchronously, so for short cycles the resumed event can
  // land in the same WebSocket batch as the send response — too late to
  // wire a listener after-the-fact. Reject (don't silently resolve) on
  // timeout: a missed resumed event leaves PauseTracker in a state that
  // would corrupt every subsequent pause-aware tool call, and surfacing
  // that as an error is strictly better than masking it.
  //
  // Returns a { promise, cancel } pair so callers awaiting
  // Promise.all([send, resumed]) can drop the waiter cleanly if send
  // throws — symmetric with how waitForPauseOrResume's waiter is removed
  // on its own timeout path. Without cancel(), a send rejection leaves
  // the waiter pending in resumeWaiters with its 2s timer still armed,
  // firing pointlessly ~2s after the tool already returned. (upstream
  // review.)
  waitForResumed(timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let waiter: ResumeWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.resumeWaiters.indexOf(waiter);
          if (i >= 0) this.resumeWaiters.splice(i, 1);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for Debugger.resumed`,
            ),
          );
        }, timeoutMs),
      };
      this.resumeWaiters.push(waiter);
    });
    const cancel = () => {
      const i = this.resumeWaiters.indexOf(waiter);
      if (i >= 0) this.resumeWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      // Resolve (don't reject) so any straggler awaiter sees a clean exit
      // — cancellation isn't an error condition, just "the caller no
      // longer needs this signal." If the promise has already settled
      // (timer fired, onResumed drained), resolve() is a no-op.
      waiter.resolve();
    };
    return { promise, cancel };
  }

  // Resolves on the next pause, or immediately if already paused.
  waitForPause(timeoutMs: number): Promise<PauseState> {
    return this.waitForPauseCancellable(timeoutMs).promise;
  }

  // The raced wait_for_pause path registers one waiter per live debug target.
  // Once one target wins, every losing waiter must be removed immediately —
  // leaving them armed until timeout would retain promises/timers and let a
  // later, unrelated pause resolve stale work. Scoped callers keep using the
  // Promise-only waitForPause() facade above; the cancellation handle is an
  // explicit opt-in for the registry-level race.
  waitForPauseCancellable(timeoutMs: number): PauseWaitHandle {
    if (this.state) {
      return { promise: Promise.resolve(this.state), cancel: () => {} };
    }

    let waiter!: Waiter;
    let settled = false;
    let rejectPromise!: (err: Error) => void;
    const promise = new Promise<PauseState>((resolve, reject) => {
      rejectPromise = reject;
      waiter = {
        resolve: (state) => {
          if (settled) return;
          settled = true;
          resolve(state);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          waiter.reject(new Error(`Timed out after ${timeoutMs}ms waiting for pause`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });

    const cancel = () => {
      if (settled) return;
      const i = this.waiters.indexOf(waiter);
      if (i >= 0) this.waiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      settled = true;
      rejectPromise(new Error("Pause wait cancelled"));
    };

    return { promise, cancel };
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
      w.reject(new PauseTrackerClosedError());
    }
    this.waiters = [];
    for (const w of this.resumeWaiters) {
      clearTimeout(w.timer);
      w.reject(new PauseTrackerClosedError());
    }
    this.resumeWaiters = [];
  }
}
