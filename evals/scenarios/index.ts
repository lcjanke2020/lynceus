// Scenario registry. Add new scenarios by importing + appending here.
//
// Why a flat registry rather than fs.readdirSync(): keeps the bundle
// resolvable from `npx tsx evals/cli.ts` without filesystem scans, makes
// the set of supported scenarios obvious in code review, and lets each
// scenario's variant directory be statically referenced.
//
// Variant-build status: `compute-step` and `adversarial-out-of-order`
// both use the canonical examples/sample-app/dist and work as soon as
// `npm run sample:build` has run. The other 6 reference
// evals/sample-app-variants/<name>/dist directories that don't ship in
// this PR — running them via `npm run eval --scenarios=<name>` will
// fail-fast with a clear error until the variants land in a follow-up
// commit. `npm run eval:quick` only runs compute-step so it stays
// green.

import type { Scenario } from "../harness/types.js";
import { computeStep } from "./compute-step.js";
import { adversarialOutOfOrder } from "./adversarial-out-of-order.js";
import { eventBinding } from "./event-binding.js";
import { consoleError } from "./console-error.js";
import { networkBug } from "./network-bug.js";
import { conditionalBp } from "./conditional-bp.js";
import { workerBug } from "./worker-bug.js";
import { deepSourceMap } from "./deep-source-map.js";

export const SCENARIOS: Record<string, Scenario> = {
  [computeStep.name]: computeStep,
  [adversarialOutOfOrder.name]: adversarialOutOfOrder,
  [eventBinding.name]: eventBinding,
  [consoleError.name]: consoleError,
  [networkBug.name]: networkBug,
  [conditionalBp.name]: conditionalBp,
  [workerBug.name]: workerBug,
  [deepSourceMap.name]: deepSourceMap,
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
