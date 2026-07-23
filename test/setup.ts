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
  /**
   * The registry-minted id. Tests must not assume counters restart at browser_1/node_1.
   * With noClient:true the record is dropped before return, so this id is diagnostic only
   * and addressed calls using it correctly fail with unknown_session rather than no_session.
   */
  sessionId: string;
}

export interface SetupOpts {
  /**
   * Exercise the no_session error path: the instance is configured but its
   * registry record is DROPPED (not just left clientless), so the accessors
   * see no session and a follow-up launch/attach is not blocked by the
   * capacity guard — mirroring the old clientless-singleton semantics.
   */
  noClient?: boolean;
  /** Mark the debugger as paused before the test starts, with an optional sessionId. */
  paused?: boolean;
  pausedSessionId?: string;
  /** Override the default chromePort (9999). */
  chromePort?: number | null;
  /** Override the default session kind ("browser"). Use "node" to exercise capability gates. */
  kind?: SessionKind;
  /** Optional registry label, useful for multi-session response contracts. */
  label?: string;
}

export function setupSession(opts: SetupOpts = {}): SessionFixture {
  resetSessions();
  const rec = registry.reserve(opts.kind ?? "browser", opts.label);
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
    return { fake, session, sessionId: rec.id };
  }
  session.client = fake as unknown as CDP.Client;
  registry.activate(rec.id);
  return { fake, session, sessionId: rec.id };
}

/**
 * Add a second, different-kind session without resetting the first one.
 * The registry's v1 capacity is one session per kind, so callers normally use
 * setupSession({kind:"browser"}) followed by setupAdditionalSession({kind:"node"}).
 */
export function setupAdditionalSession(opts: Omit<SetupOpts, "noClient"> = {}): SessionFixture {
  const rec = registry.reserve(opts.kind ?? "browser", opts.label);
  const session = rec.state;
  const fake = makeFakeCdp();
  session.chromePort = opts.chromePort === null ? null : opts.chromePort ?? 9999;
  if (opts.paused) {
    session.pause.onPaused(fake.makePauseState({ sessionId: opts.pausedSessionId }));
  }
  session.client = fake as unknown as CDP.Client;
  registry.activate(rec.id);
  return { fake, session, sessionId: rec.id };
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
