// Shared system prompts + oracle helpers for the issue-#12 driving /
// session-portability L4 scenarios (form-drive, clearing-fill,
// idempotent-toggle, robust-locator, session-resume, cookie-redaction).
//
// Why these scenarios need their own system prompt: the runner's default
// (runner.ts SYSTEM_PROMPT_PREFIX) is a debugger SDET test plan —
// "set_breakpoint → wait_for_pause → name the buggy file:line". That framing
// is wrong for *driving* a page or *resuming* a session, so each of these
// scenarios sets `systemPromptOverride` to one of the two constants below
// (the same mechanism adversarial-out-of-order uses). DRIVING_SYSTEM covers
// the form/locator scenarios; RESUME_SYSTEM adds the session-lifecycle framing
// the resume scenario needs (kept separate so the close/relaunch guidance
// doesn't leak into — and telegraph the answer for — the form scenarios).
//
// The "do not mutate via raw evaluate/JS" instruction is the mechanic-
// protection lever: the dedicated driver tools are what's under test, so an
// agent that side-steps them with `evaluate("el.value = ...")` has not
// exercised the tool. It mirrors how the debugger prompt forbids solving by
// reading source. The oracle helper `mutatedViaEvaluate` enforces it.

const COMMON_OPENING = `You are a web-automation agent driving a real browser through a Chrome DevTools Protocol (CDP) MCP server. Your job is to complete UI tasks on the page under test reliably, then verify and report the resulting state.

Workflow:
  1. Open a browser — launch_chrome (headless) or attach_chrome — and navigate to the page under test. (You are given its URL; nothing auto-navigates for you.)
  2. Locate elements robustly. Prefer semantic locators (role + accessible name, label, placeholder, test id) over brittle CSS. suggest_locator ranks candidates for an element and reports how many elements each one matches (1 = unambiguous).
  3. Drive each control with the tool that matches its type:
       - fill — set a text <input>/<textarea>/contenteditable to an EXACT value (it replaces the existing contents).
       - type_text — only when you specifically want to APPEND keystrokes (it does not clear first by default).
       - select_option — for a native <select>, by option_value, option_label, or option_index; pass multiple:true for a <select multiple>.
       - check / uncheck — for checkboxes and radios. These are idempotent (they no-op if the control is already in the requested state), so prefer them over click, which blindly toggles.
  4. Do NOT mutate form/page state with raw evaluate/JavaScript — the dedicated driver tools are what this test exercises. Use evaluate only for read-only inspection when no dedicated read tool can answer.
  5. Verify the end state (get_form_state / get_cookies) before answering, and close_session when done.

Tool errors come back as a structured { error: code, message } envelope — read the code, fix the call, and retry.`;

export const DRIVING_SYSTEM = `${COMMON_OPENING}

When done, write a short final answer reporting the final value of each field/control you were asked about.`;

export const RESUME_SYSTEM = `${COMMON_OPENING}

Session portability: to prove a session truly resumes, do NOT just re-read state that is still present. Seed the state, then export_storage_state to the given file path, then start a GENUINELY fresh browser — close_session, then launch_chrome again (a fresh launch has an empty cookie jar and empty storage) — and reload the page to confirm the seeded state is gone. Then load_storage_state from the file into the fresh session and verify the values returned. Note: load_storage_state restores localStorage only for the origin matching the current page, and ADDS cookies on top of the current jar.

When done, write a short final answer stating whether the resume succeeded and the restored values.`;

// ---------------------------------------------------------------------------
// Oracle helpers shared across the driving/portability scenario oracles. Each
// operates on the `toolPairs(trace)` shape: { tool, input, output, isError, errorCode }.

export interface Pair {
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  errorCode?: string;
}

/** The tool's result object on success (or {} for errors / non-object output). */
export function out(p: Pair | undefined): Record<string, unknown> {
  return p && p.output && typeof p.output === "object" ? (p.output as Record<string, unknown>) : {};
}

/** Last element of an array, or undefined. */
export function last<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}

/** Stable, regex-friendly stringification of a tool's input. */
export function inputText(input: unknown): string {
  try {
    return JSON.stringify(input ?? "");
  } catch {
    return String(input);
  }
}

/**
 * True if any `evaluate` call mutated page/form/storage state via raw JS —
 * the shortcut the driving scenarios forbid (the dedicated tools are under
 * test). Matches assignment to value/checked/selected, localStorage.setItem,
 * dispatchEvent, and document.cookie writes. Read-only evaluates (getItem,
 * querySelector, location.origin) don't match.
 */
export function mutatedViaEvaluate(calls: Pair[]): boolean {
  return calls.some(
    (c) =>
      c.tool === "evaluate" &&
      /setItem|dispatchEvent|\.value\s*=|\.checked\s*=|\.selected\s*=|document\.cookie\s*=/.test(inputText(c.input)),
  );
}
