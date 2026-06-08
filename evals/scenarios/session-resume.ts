// Scenario: session-resume — the marquee session-portability flow. The
// `stateful-app` variant writes localStorage["user_pref"]="dark" on load. The
// agent seeds a session cookie, exports the session to a file, starts a
// GENUINELY fresh browser (close_session + launch_chrome — empty jar/storage),
// confirms the state is gone, then restores it and verifies. The trap: claiming
// "resumed" without ever resetting (re-reading state that was never cleared) —
// the oracle requires a real close + relaunch.
//
// Covers (issue #12): export_storage_state, load_storage_state, set_cookies,
// get_cookies.
//
// Starts as xfailCorrectness:true — this is the longest, most multi-phase
// driving flow (close/relaunch is unusual under a driving prompt) and the most
// likely to be flaky on the first real run. Flip to false once the baseline is
// stable (same playbook as adversarial-out-of-order). Mechanic is not xfail.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { RESUME_SYSTEM, out, last } from "./_driving-prompts.js";

const PROMPT = `This page saves a user preference to localStorage (key "user_pref") and treats a cookie named "session_token" as your logged-in session. Demonstrate saving and resuming the session in a fresh browser:
1. Make sure you are "logged in": set a cookie named "session_token" on this site.
2. Save the full browser session (cookies + localStorage) to the file /tmp/cdp-mcp-eval-session.json.
3. Start a completely fresh browser and load the page — confirm you are logged out (the session_token cookie is gone).
4. Restore the saved session into the fresh browser, then verify the session_token cookie is back and read the saved "user_pref" value.
Report whether the resume succeeded and the value of "user_pref" you recovered.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  const exported = last(ok("export_storage_state"));
  const loaded = last(ok("load_storage_state"));
  const closed = c.some((x) => x.tool === "close_session" && !x.isError);
  const launches = c.filter((x) => x.tool === "launch_chrome" && !x.isError).length;

  // MECHANIC — a real export → reset → restore → verify cycle.
  const exportHadState = !!exported && Number(out(exported).cookies ?? 0) >= 1;
  const loadRestored =
    !!loaded &&
    (((out(loaded).origins_restored as string[] | undefined)?.length ?? 0) >= 1 ||
      Number(out(loaded).cookies ?? 0) >= 1);
  const loadIdx = c.findIndex((x) => x.tool === "load_storage_state" && !x.isError);
  const verifyAfterLoad =
    loadIdx >= 0 &&
    c.slice(loadIdx + 1).some((x) => ["get_cookies", "get_form_state", "evaluate"].includes(x.tool) && !x.isError);
  // ≥2 launch_chrome proves a genuine fresh session (initial + post-close relaunch).
  const realReset = closed && launches >= 2;
  const mechanic: 0 | 1 =
    !!exported && !!loaded && realReset && exportHadState && loadRestored && verifyAfterLoad ? 1 : 0;

  // CORRECTNESS — mechanic already required a post-load verify read; the answer
  // must affirm a successful resume and name the restored value (user_pref=dark,
  // which the agent can only know by reading it back).
  const faSuccess =
    /(restor|resum|surviv|recover|came back|\bback\b|success|succeed)/i.test(finalAnswer) &&
    /user_pref/i.test(finalAnswer) &&
    /dark/i.test(finalAnswer);
  const correctness: 0 | 1 = mechanic === 1 && faSuccess ? 1 : 0;

  const why: string[] = [];
  if (!exported) why.push("mechanic: never called export_storage_state");
  if (!exportHadState) why.push("mechanic: export captured no cookies (was the session seeded?)");
  if (!realReset) why.push("mechanic: no genuine fresh session (need close_session + a 2nd launch_chrome)");
  if (!loaded) why.push("mechanic: never called load_storage_state");
  if (!loadRestored) why.push("mechanic: load_storage_state restored nothing");
  if (!verifyAfterLoad) why.push("mechanic: did not verify state after restoring");
  if (!faSuccess) why.push("correctness: final answer did not affirm resume with user_pref=dark");

  const summary = `session-resume correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — exported, reset to a fresh browser, restored, and verified user_pref`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const sessionResume: Scenario = {
  name: "session-resume",
  variantDir: "evals/sample-app-variants/stateful-app/dist",
  prompt: PROMPT,
  systemPromptOverride: RESUME_SYSTEM,
  oracle,
  // launch + navigate + set_cookies + export + close + launch + navigate + load + verify ≈ 9.
  oracleMinimumToolCalls: 9,
  xfailCorrectness: true,
};
