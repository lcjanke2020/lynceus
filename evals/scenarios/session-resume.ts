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
// Tagged xfailCorrectness:true (longest, most multi-phase driving flow —
// close/relaunch is unusual under a driving prompt). The first full Opus-4.8 run
// (2026-06-08) passed it 3/3 (XPASS!), but PR #17 review then TIGHTENED this
// oracle (require proof of the localStorage-restore path, not just cookies), so
// that pass was under a looser check — keep the xfail hedge until a fresh nightly
// re-establishes the baseline under the stricter oracle, then drop it.

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { RESUME_SYSTEM, out, last, mutatedViaEvaluate } from "./_driving-prompts.js";

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
  // The export must capture BOTH halves (cookies AND the origin's localStorage),
  // and the restore must report it restored the origin's localStorage — not just
  // cookies. Keying loadRestored on origins_restored (rather than a cookies-OR)
  // proves load_storage_state actually ran its localStorage path; a cookie-only
  // restore no longer passes (codex, PR #17). The stateful-app fixture writes
  // user_pref on load, so the displayed value isn't itself the proof — the
  // origins_restored signal is.
  const exportHadState =
    !!exported && Number(out(exported).cookies ?? 0) >= 1 && Number(out(exported).origins ?? 0) >= 1;
  const loadRestored = !!loaded && ((out(loaded).origins_restored as string[] | undefined)?.length ?? 0) >= 1;
  // Use the LAST successful load (the agent may retry after a wrong path) so the
  // verify-after check is relative to the load that mattered (Copilot, PR #17).
  const loadIdx = c.map((x) => x.tool === "load_storage_state" && !x.isError).lastIndexOf(true);
  const verifyAfterLoad =
    loadIdx >= 0 &&
    c.slice(loadIdx + 1).some((x) => ["get_cookies", "get_form_state", "evaluate"].includes(x.tool) && !x.isError);
  // ≥2 launch_chrome proves a genuine fresh session (initial + post-close relaunch).
  const realReset = closed && launches >= 2;
  // Forbid seeding/restoring state through raw evaluate — set_cookies +
  // load_storage_state are the tools under test (kimi, PR #17). Read-only
  // localStorage.getItem / document.cookie reads are not flagged.
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 =
    !!exported && !!loaded && realReset && exportHadState && loadRestored && verifyAfterLoad && noEvalMutation
      ? 1
      : 0;

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
  if (!exportHadState) why.push("mechanic: export did not capture both cookies and the origin's localStorage");
  if (!realReset) why.push("mechanic: no genuine fresh session (need close_session + a 2nd launch_chrome)");
  if (!loaded) why.push("mechanic: never called load_storage_state");
  if (!loadRestored) why.push("mechanic: load_storage_state did not restore the origin's localStorage (origins_restored empty)");
  if (!verifyAfterLoad) why.push("mechanic: did not verify state after restoring");
  if (!noEvalMutation) why.push("mechanic: seeded/restored state via raw evaluate instead of set_cookies/load_storage_state");
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
  // Re-hedged after PR #17 tightened the oracle — drop once a nightly passes
  // under the stricter localStorage-restore check.
  xfailCorrectness: true,
};
