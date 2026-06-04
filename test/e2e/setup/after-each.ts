// Shared afterEach hook for every e2e spec. Vitest's `setupFiles` runs this
// once per test-file, registering an afterEach that detaches whatever CDP
// session the spec opened.
//
// Why a shared hook instead of relying on per-spec close_session discipline
// (plan rev 4 N-6 fix): vitest with pool=forks + singleFork:true keeps the
// same worker fork alive after a thrown assertion. Without this hook, an
// open breakpoint or paused-execution state from a crashed spec leaks into
// the next spec — observed as cascading false failures that don't reproduce
// in isolation. The try/catch swallows close errors because by definition
// we're cleaning up after potentially-broken state.

import { afterEach } from "vitest";
import { closeSession } from "../../../src/session/browser.js";
import { sessionState } from "../../../src/session/state.js";

afterEach(async () => {
  if (sessionState.client) {
    try {
      await closeSession();
    } catch {
      /* deliberate — cleanup after possibly-broken state */
    }
  }
});
