// Scenario registry. Add new scenarios by importing + appending here.
//
// Why a flat registry rather than fs.readdirSync(): keeps the bundle
// resolvable from `npx tsx evals/cli.ts` without filesystem scans, makes
// the set of supported scenarios obvious in code review, and lets each
// scenario's fixture coordinates be statically referenced.
//
// Fixture-build status: static browser scenarios are runnable once `npm run
// sample:build` has run. Five use examples/sample-app/dist and the remaining
// static rows use evals/sample-app-variants/<name>/dist. Node, React-development,
// and dual targets use their dedicated build hooks. `npm run eval:quick` only
// runs compute-step so the per-PR gate stays green/cheap.

import type { Scenario } from "../harness/types.js";
import { computeStep } from "./compute-step.js";
import { adversarialOutOfOrder } from "./adversarial-out-of-order.js";
import { eventBinding } from "./event-binding.js";
import { consoleError } from "./console-error.js";
import { networkBug } from "./network-bug.js";
import { conditionalBp } from "./conditional-bp.js";
import { workerBug } from "./worker-bug.js";
import { deepSourceMap } from "./deep-source-map.js";
// Issue #12 driving + session-portability scenarios.
import { formDrive } from "./form-drive.js";
import { clearingFill } from "./clearing-fill.js";
import { idempotentToggle } from "./idempotent-toggle.js";
import { robustLocator } from "./robust-locator.js";
import { sessionResume } from "./session-resume.js";
import { cookieRedaction } from "./cookie-redaction.js";
// Node L4 scenarios.
import { nodeComputeStep } from "./node-compute-step.js";
import { nodeStdioBug } from "./node-stdio-bug.js";
import { nodeConditionalBp } from "./node-conditional-bp.js";
import { nodeUncaughtThrow } from "./node-uncaught-throw.js";
// First concurrent browser + Node L4 scenario.
import { fullstackCart } from "./fullstack-cart.js";
// React DevTools read-surface scenarios.
import { reactStaleClosure } from "./react-stale-closure.js";
import { reactContextProvider } from "./react-context-provider.js";

export const SCENARIOS: Record<string, Scenario> = {
  [computeStep.name]: computeStep,
  [adversarialOutOfOrder.name]: adversarialOutOfOrder,
  [eventBinding.name]: eventBinding,
  [consoleError.name]: consoleError,
  [networkBug.name]: networkBug,
  [conditionalBp.name]: conditionalBp,
  [workerBug.name]: workerBug,
  [deepSourceMap.name]: deepSourceMap,
  // Issue #12 driving + session-portability scenarios.
  [formDrive.name]: formDrive,
  [clearingFill.name]: clearingFill,
  [idempotentToggle.name]: idempotentToggle,
  [robustLocator.name]: robustLocator,
  [sessionResume.name]: sessionResume,
  [cookieRedaction.name]: cookieRedaction,
  // Node L4 scenarios.
  [nodeComputeStep.name]: nodeComputeStep,
  [nodeStdioBug.name]: nodeStdioBug,
  [nodeConditionalBp.name]: nodeConditionalBp,
  [nodeUncaughtThrow.name]: nodeUncaughtThrow,
  // Dual-target L4 scenario.
  [fullstackCart.name]: fullstackCart,
  // React DevTools read-surface scenarios.
  [reactStaleClosure.name]: reactStaleClosure,
  [reactContextProvider.name]: reactContextProvider,
};

export function lookupScenario(name: string): Scenario {
  const s = SCENARIOS[name];
  if (!s) {
    throw new Error(
      `Unknown scenario '${name}'. Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
  }
  return s;
}
