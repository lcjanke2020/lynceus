// Scenario: cookie-redaction — redaction-aware cookie inspection. The agent
// seeds two cookies (a session/auth-looking one and a benign one) via
// set_cookies, then lists them with get_cookies and classifies which value the
// tool redacted (and why) and which is safe to log. get_cookies redacts the
// value of httpOnly cookies OR names matching sess/sid/token/auth/csrf/jwt/
// secret/api-key. Uses the stock sample-app (cookies are origin-scoped to the
// served page — no fixture needed; the agent seeds them).
//
// Covers (issue #12): set_cookies, get_cookies (redaction heuristic).

import type { Scenario, TraceEntry, OracleResult } from "../harness/types.js";
import { toolPairs } from "../harness/trace.js";
import { DRIVING_SYSTEM, out, last, mutatedViaEvaluate } from "./_driving-prompts.js";

const PROMPT = `Set two cookies on this site: one named "session_token" with value "abc123secret", and one named "theme" with value "dark". Then list the cookies with the inspection tool and report, for each of the two, whether the tool redacted its value (and why), and which of the two is safe to print in a log.`;

function oracle(trace: TraceEntry[], finalAnswer: string): OracleResult {
  const c = toolPairs(trace);
  const ok = (t: string) => c.filter((x) => x.tool === t && !x.isError);

  const setCookies = last(ok("set_cookies"));
  const cookies = (out(last(ok("get_cookies"))).cookies ?? []) as Array<{
    name: string;
    value?: string;
    redacted?: boolean;
    value_length?: number;
  }>;
  const sess = cookies.find((k) => k.name === "session_token");
  const theme = cookies.find((k) => k.name === "theme");

  // MECHANIC — both cookies set via set_cookies (not document.cookie via raw
  // evaluate — kimi, PR #17) + listed, with the redaction applied as designed:
  // session_token value hidden (redacted, value_length>0), theme value shown.
  const noEvalMutation = !mutatedViaEvaluate(c);
  const mechanic: 0 | 1 =
    !!setCookies &&
    noEvalMutation &&
    !!sess &&
    !!theme &&
    sess.redacted === true &&
    sess.value === undefined &&
    Number(sess.value_length ?? 0) > 0 &&
    theme.redacted === false &&
    theme.value === "dark"
      ? 1
      : 0;

  // CORRECTNESS — the answer classifies session_token as redacted/unsafe and
  // theme as safe to log.
  const fa = finalAnswer.toLowerCase();
  const faOk =
    /session_token/i.test(finalAnswer) &&
    /(redact|hidden|not safe|unsafe|sensitive|secret|masked)/.test(fa) &&
    /theme/i.test(finalAnswer) &&
    /(safe|benign|not redacted|shown|visible|ok to (print|log)|loggable)/.test(fa);
  const correctness: 0 | 1 = mechanic === 1 && faOk ? 1 : 0;

  const why: string[] = [];
  if (!setCookies) why.push("mechanic: never set the cookies via set_cookies");
  if (!noEvalMutation) why.push("mechanic: set cookies via raw evaluate (document.cookie) instead of set_cookies");
  if (!sess || !theme) why.push("mechanic: get_cookies did not return both cookies");
  else {
    if (sess.redacted !== true || sess.value !== undefined) why.push("mechanic: session_token value was not redacted");
    if (theme.redacted !== false || theme.value !== "dark") why.push("mechanic: theme value was unexpectedly redacted");
  }
  if (!faOk) why.push("correctness: final answer did not correctly classify redacted vs safe");

  const summary = `cookie-redaction correctness=${correctness} mechanic=${mechanic}`;
  return {
    correctness,
    mechanic,
    efficiency: 0,
    recovery: 0,
    notes:
      correctness === 1 && mechanic === 1
        ? `${summary}: solved — set both cookies and correctly read the redaction`
        : `${summary}: ${why.join("; ")}`,
  };
}

export const cookieRedaction: Scenario = {
  name: "cookie-redaction",
  variantDir: "examples/sample-app/dist",
  prompt: PROMPT,
  systemPromptOverride: DRIVING_SYSTEM,
  oracle,
  // launch + navigate + set_cookies + get_cookies (+ report) ≈ 5.
  oracleMinimumToolCalls: 5,
};
