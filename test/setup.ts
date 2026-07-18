// Shared L2 setup helpers. Each tool test file uses these to mint a session
// through the SessionRegistry, wire a fake CDP into it, and tear it down
// between tests. Without `afterEach(resetSessions)`, records leak across
// files because the registry is a module-singleton.

import { afterEach } from "vitest";
import type CDP from "chrome-remote-interface";
import { registry, type Session, type SessionKind } from "../src/session/state.js";
import { makeFakeCdp, type FakeCdp } from "./fake-cdp.js";

export interface SessionFixture {
  fake: FakeCdp;
  /** The registry-minted SessionState instance the test can inspect and mutate. */
  session: Session;
}

export interface SetupOpts {
  /** Skip registering the session — for tests that exercise the no_session error path. */
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
  resetSessions();
  const rec = registry.reserve(opts.kind ?? "browser");
  const session = rec.state;
  const fake = makeFakeCdp();
  session.chromePort = opts.chromePort === null ? null : opts.chromePort ?? 9999;
  if (opts.paused) {
    session.pause.onPaused(fake.makePauseState({ sessionId: opts.pausedSessionId }));
  }
  if (opts.noClient) {
    // The no_session error path: drop the reservation so the accessors see
    // no session and a follow-up launch isn't blocked by the capacity guard
    // (mirrors the old clientless singleton). The configured instance is
    // still returned so the fixture shape stays uniform.
    resetSessions();
    return { fake, session };
  }
  session.client = fake as unknown as CDP.Client;
  registry.activate(rec.id);
  return { fake, session };
}

/** Drop every registry record (test seam — no close() side effects). */
export function resetSessions(): void {
  registry.resetForTests();
}

/** Auto-reset the session registry after every test in the importing file. */
export function autoReset() {
  afterEach(() => {
    resetSessions();
  });
}
