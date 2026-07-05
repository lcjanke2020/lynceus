// Shared L2 setup helpers. Each tool test file uses these to wire a fake
// CDP into the global sessionState singleton and tear it down between
// tests. Without `afterEach(resetSession)`, state leaks across files
// because sessionState is a module-singleton.

import { afterEach } from "vitest";
import type CDP from "chrome-remote-interface";
import { sessionState, type SessionKind } from "../src/session/state.js";
import { makeFakeCdp, type FakeCdp } from "./fake-cdp.js";

export interface SessionFixture {
  fake: FakeCdp;
}

export interface SetupOpts {
  /** Skip wiring the fake's client — for tests that exercise the no_session error path. */
  noClient?: boolean;
  /** Mark the debugger as paused before the test starts, with an optional sessionId. */
  paused?: boolean;
  pausedSessionId?: string;
  /** Override the default chromePort (9999). */
  chromePort?: number | null;
  /** Override the default session kind ("browser"). Use "node" to exercise capability gates. */
  kind?: SessionKind;
}

export function setupSession(opts: SetupOpts = {}): SessionFixture {
  sessionState.reset();
  const fake = makeFakeCdp();
  if (!opts.noClient) {
    sessionState.client = fake as unknown as CDP.Client;
  }
  sessionState.chromePort = opts.chromePort === null ? null : opts.chromePort ?? 9999;
  if (opts.kind) sessionState.kind = opts.kind;
  if (opts.paused) {
    sessionState.pause.onPaused(fake.makePauseState({ sessionId: opts.pausedSessionId }));
  }
  return { fake };
}

/** Auto-reset sessionState after every test in the importing file. */
export function autoReset() {
  afterEach(() => {
    sessionState.reset();
  });
}
