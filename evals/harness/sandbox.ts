// L4 eval-harness sandbox policy: turn the `EVAL_SANDBOX` intent + the host's
// detected Chromium sandbox capability into a single launch decision.
//
// Background (GH #41 / LEO-398): the harness historically launched the model-
// driven Chromium `--no-sandbox` by default and only ran sandbox-on as an
// unconditional opt-in (`EVAL_SANDBOX=true` → `CDP_SANDBOX=true`). So a normal
// `npm run eval` on a sandbox-capable host never exercised the representative
// sandboxed launch path, and the default was silent. This module makes the
// default auto-detect (sandbox-on when the host supports it), keeps
// `EVAL_SANDBOX=true` as a fail-loud force-on alias, and adds an explicit
// force-off — then reports the outcome + its source in the run header.
//
// The capability probe (does THIS binary have a usable sandbox path on THIS
// host?) lives next to the browser resolver in src/util/browser-resolve.ts,
// since both are "resolved-binary + host" facts shared with the e2e layer.

import {
  detectSandboxCapability,
  type SandboxCapability,
} from "../../src/util/browser-resolve.js";

/** Operator intent from the `EVAL_SANDBOX` env var. */
export type SandboxIntent = "on" | "off" | "auto";

/** Parse `EVAL_SANDBOX` into a tri-state intent.
 *
 *  - unset / `auto`        → auto-detect (the new default)
 *  - `true` / `1` / `on`   → force sandbox on (fails fast if incapable)
 *  - `false` / `0` / `off` → force sandbox off (`--no-sandbox`)
 *
 *  `true`/`1` preserve the pre-#41 force-on semantics exactly. Anything else
 *  throws — a typo'd intent must not silently degrade to a surprising default.
 */
export function parseSandboxIntent(raw: string | undefined): SandboxIntent {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "auto") return "auto";
  if (v === "true" || v === "1" || v === "on") return "on";
  if (v === "false" || v === "0" || v === "off") return "off";
  throw new Error(
    `EVAL_SANDBOX must be one of on/true/1, off/false/0, or auto (got '${raw}').`,
  );
}

/** Where the on/off outcome came from — surfaced in the run header. */
export type SandboxSource =
  | "forced-on" // EVAL_SANDBOX=on, host is capable
  | "forced-off" // EVAL_SANDBOX=off
  | "auto-capable" // auto + host supports the sandbox → on
  | "auto-fallback"; // auto + host lacks a sandbox path → off with reason

export interface SandboxDecision {
  /** Whether Chromium should launch WITH the sandbox (→ CDP_SANDBOX). */
  enabled: boolean;
  source: SandboxSource;
  /** Rationale (capability reason, or the forced-off marker). */
  reason: string;
}

/** Fold intent + capability into a decision. Force-on against an incapable
 *  host throws (fail fast) rather than silently downgrading to `--no-sandbox`,
 *  which is the point of an explicit "I want the sandbox" request. */
export function resolveSandboxDecision(
  intent: SandboxIntent,
  cap: SandboxCapability,
): SandboxDecision {
  if (intent === "on") {
    if (!cap.capable) {
      throw new Error(
        `EVAL_SANDBOX=on requested but this host has no usable Chromium sandbox path: ${cap.reason}. ` +
          `Fix the host (see docs/chromium-sandboxing.md) or unset EVAL_SANDBOX to auto-detect, or set EVAL_SANDBOX=off.`,
      );
    }
    return { enabled: true, source: "forced-on", reason: cap.reason };
  }
  if (intent === "off") {
    return { enabled: false, source: "forced-off", reason: "EVAL_SANDBOX=off" };
  }
  return cap.capable
    ? { enabled: true, source: "auto-capable", reason: cap.reason }
    : { enabled: false, source: "auto-fallback", reason: cap.reason };
}

/** Convenience: read `EVAL_SANDBOX`, probe the given binary, and decide.
 *  Throws on an invalid intent or a force-on/incapable mismatch. */
export function decideEvalSandbox(binaryPath: string): SandboxDecision {
  const intent = parseSandboxIntent(process.env.EVAL_SANDBOX);
  const cap = detectSandboxCapability(binaryPath);
  return resolveSandboxDecision(intent, cap);
}

/** The unconditional run-header line describing the sandbox posture. */
export function formatSandboxHeader(d: SandboxDecision): string {
  return `[eval] sandbox: ${d.enabled ? "on" : "off"} (source=${d.source}; ${d.reason})`;
}
