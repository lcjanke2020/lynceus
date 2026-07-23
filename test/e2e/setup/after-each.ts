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
import { registry } from "../../../src/session/state.js";

afterEach(async () => {
  // Unconditional (round-1 review): gating on getSession() would skip a
  // record wedged with a null client — invisible to the accessors but still
  // holding reserve() capacity — and cascade already_session into later
  // specs. closeAll() resolves every record regardless of the client sentinel
  // (and closes both sides of a dual-session spec), and is a no-op when none
  // exist.
  try {
    await registry.closeAll();
  } catch {
    /* deliberate — cleanup after possibly-broken state */
  }
});
