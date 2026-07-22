// Scenario: fullstack-cart — first dual-target L4 trial.
//
// One lynceus subprocess owns a browser session and a Node session at the
// same time. The frontend sends a valid JSON add-to-cart request, but the
// Express router is registered before express.json(), so req.body is
// undefined and the handler silently returns an empty cart.
//
// The deterministic mechanic follows docs/dual-target-debugging.md §11:
//   1. list_sessions proves one browser + one Node session were live together;
//   2. a breakpoint binds in CartButton.tsx under the browser session;
//   3. a breakpoint binds in cart.ts under the Node session;
//   4. the Node-scoped wait observes that backend breakpoint in cart.ts.
//
// Breakpoint ids are deliberately treated as per-session values. Browser and
// Node can both mint "bp_1"; every association below includes the debug-target
// session id, so a same-string collision cannot satisfy the wrong side.

import type { OracleResult, Scenario, TraceEntry } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";

const PROMPT = `After clicking an Add to cart button, the cart badge still shows 0 items even though the request returns successfully. Follow one add-to-cart request across the concurrently live frontend and backend debug sessions. Bind a TypeScript/TSX breakpoint on each side, prove the request reaches the Node handler, inspect the paused backend state, and report the root cause as file:line. Do not modify the planted fixture.`;

interface Pair {
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function sessionFromLaunch(calls: Pair[], tool: "launch_node" | "launch_chrome"):
  | string
  | undefined {
  // Agents commonly recover from a bad launch by closing that target and
  // launching it again. Grade the final successful attempt rather than
  // pinning every later oracle check to an abandoned first-session id.
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || call.tool !== tool || call.isError) continue;
    const session = record(call.output).session;
    if (typeof session === "string") return session;
  }
  return undefined;
}

function boundBreakpoints(
  calls: Pair[],
  session: string | undefined,
  fileSuffix: string,
): Pair[] {
  if (session === undefined) return [];
  return calls.filter((call) => {
    if (call.tool !== "set_breakpoint" || call.isError) return false;
    const input = record(call.input);
    const output = record(call.output);
    if (input.session !== session) return false;
    if (!String(input.file ?? "").endsWith(fileSuffix)) return false;
    if (typeof output.id !== "string") return false;
    if (typeof output.binding_count !== "number" || output.binding_count < 1) {
      return false;
    }
    const resolved = output.resolved_locations;
    return (
      Array.isArray(resolved) &&
      resolved.some((location) =>
        String(record(location).file ?? "").endsWith(fileSuffix),
      )
    );
  });
}

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const calls = toolPairs(trace) as Pair[];
  const nodeSession = sessionFromLaunch(calls, "launch_node");
  const browserSession = sessionFromLaunch(calls, "launch_chrome");

  const concurrentKinds = calls.some((call) => {
    if (call.tool !== "list_sessions" || call.isError) return false;
    const sessions = record(call.output).sessions;
    if (!Array.isArray(sessions)) return false;
    const sawNode = sessions.some((item) => {
      const value = record(item);
      return value.session === nodeSession && value.kind === "node";
    });
    const sawBrowser = sessions.some((item) => {
      const value = record(item);
      return value.session === browserSession && value.kind === "browser";
    });
    return sawNode && sawBrowser && nodeSession !== browserSession;
  });

  const frontendBps = boundBreakpoints(
    calls,
    browserSession,
    "CartButton.tsx",
  );
  const backendBps = boundBreakpoints(calls, nodeSession, "cart.ts");

  // Recovery can legitimately remove an initially bound breakpoint and bind a
  // better line. Accept a pause for any successfully bound backend breakpoint
  // rather than pinning the mechanic to the first one.
  const nodePause = backendBps.some((backendBp) => {
    const backendBpId = record(backendBp.output).id;
    const backendBpIndex = calls.indexOf(backendBp);
    return (
      typeof backendBpId === "string" &&
      calls.slice(backendBpIndex + 1).some((call) => {
        if (call.tool !== "wait_for_pause" || call.isError) return false;
        if (record(call.input).session !== nodeSession) return false;
        const output = record(call.output);
        const hitIds = output.hit_breakpoint_ids;
        const stack = output.call_stack;
        return (
          Array.isArray(hitIds) &&
          hitIds.includes(backendBpId) &&
          Array.isArray(stack) &&
          stack.some((frame) =>
            String(record(frame).file ?? "").endsWith("cart.ts"),
          )
        );
      })
    );
  });

  const mechanic: 0 | 1 =
    concurrentKinds && frontendBps.length > 0 && backendBps.length > 0 && nodePause
      ? 1
      : 0;

  const mentionsFile = /(?:index|cart)\.ts/i.test(finalAnswer);
  const namesMiddlewareOrder =
    /(?:express\.json|body[- ]?parser|json (?:body )?(?:parser|middleware))/i.test(
      finalAnswer,
    ) &&
    /(?:after|before|order|register(?:ed|s|ing)?|runs? too late|never runs?)/i.test(
      finalAnswer,
    );
  const namesUnparsedBody =
    /req\.body/i.test(finalAnswer) &&
    /(?:undefined|missing|empty|unparsed|not (?:being )?parsed|never parsed)/i.test(
      finalAnswer,
    );
  const correctness: 0 | 1 =
    mentionsFile && (namesMiddlewareOrder || namesUnparsedBody) ? 1 : 0;

  const why: string[] = [];
  if (!nodeSession) why.push("mechanic: no successful launch_node session");
  if (!browserSession) why.push("mechanic: no successful launch_chrome session");
  if (!concurrentKinds)
    why.push(
      "mechanic: list_sessions never showed the launched browser and Node sessions live together",
    );
  if (frontendBps.length === 0)
    why.push(
      "mechanic: no browser-session breakpoint bound to CartButton.tsx",
    );
  if (backendBps.length === 0)
    why.push("mechanic: no Node-session breakpoint bound to cart.ts");
  if (!nodePause)
    why.push(
      "mechanic: no Node-scoped pause hit that backend breakpoint in cart.ts",
    );
  if (!mentionsFile)
    why.push("correctness: final answer does not mention index.ts or cart.ts");
  if (!namesMiddlewareOrder && !namesUnparsedBody)
    why.push(
      "correctness: final answer does not identify late JSON middleware or an unparsed req.body",
    );

  const summary = `fullstack-cart correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — concurrent sessions + two coordinate spaces + Node handler pause proven`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const fullstackCart: Scenario = {
  name: "fullstack-cart",
  target: {
    kind: "dual",
    webAppDir: "examples/sample-fullstack-app",
    webUrl: "http://127.0.0.1:5173",
    script: "examples/sample-fullstack-app/server/dist/index.js",
  },
  prompt: PROMPT,
  oracle,
  // backend launch + entry wait + backend bp + resume + browser launch +
  // list_sessions + frontend bp + trigger/pause/inspect/resume + backend
  // pause/inspect/resume + two closes. Fewer than ~14 calls generally means
  // one of the two runtime paths was skipped.
  oracleMinimumToolCalls: 14,
  // New cross-session scenario: keep both axes expected-failure until a
  // multi-trial baseline demonstrates stable behavior. An isolated XPASS is
  // useful evidence, not enough on its own to remove either tag.
  xfailCorrectness: true,
  xfailMechanic: true,
};
