export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const noSession = () =>
  new ToolError(
    "no_session",
    "No active session. Call launch_chrome, attach_chrome, launch_node, or attach_node first.",
  );

export const notPaused = () =>
  new ToolError(
    "not_paused",
    "Operation requires the debugger to be paused. Set a breakpoint and call wait_for_pause.",
  );

// A live session as the recovery-oriented errors (ambiguous_session /
// unknown_session) name it. Structurally a subset of SessionSummary
// (src/session/state.ts) so a summary array passes without a cast; declared
// here to keep errors.ts free of a runtime import back into the session layer.
export interface SessionCandidate {
  session: string;
  kind: "browser" | "node";
  label: string | null;
}

// Renders the live-session list shared by ambiguous_session / unknown_session.
// "(none)" when empty so the message still reads cleanly with zero live
// sessions (unknown_session can fire against an already-closed id). Labels go
// through JSON.stringify so an empty, quote-, or newline-bearing label stays
// visible and unambiguous instead of vanishing or breaking the delimiters.
function formatCandidates(candidates: readonly SessionCandidate[]): string {
  if (candidates.length === 0) return "(none)";
  return candidates
    .map((c) => `${c.session} (${c.kind}${c.label !== null ? `, label ${JSON.stringify(c.label)}` : ""})`)
    .join(", ");
}

// Per-kind capacity guard (design §4/§10). v1 allows one live session per
// kind; a second same-kind launch/attach names the incumbent so the agent
// knows exactly what to close. When the incumbent isn't yet "active" — it is
// still spinning up, or mid-teardown in its SIGTERM grace window — the "close
// it" advice can't work (close_session(id) would 404 the transient record), so
// the message says "retry shortly" instead. `kind`/`status` are inlined as
// unions (not imported from state.ts) to keep this module import-cycle-free.
export const alreadySession = (
  liveId: string,
  kind: "browser" | "node",
  status: "starting" | "active" | "closing" = "active",
) => {
  const rule = "lynceus allows one session per kind.";
  const msg =
    status === "active"
      ? `A ${kind} session (${liveId}) is already active — ${rule} Close it with close_session before opening another ${kind} session.`
      : `A ${kind} session (${liveId}) is still ${status === "closing" ? "shutting down" : "starting up"} — ${rule} Retry shortly.`;
  return new ToolError("already_session", msg);
};

// Omitted `session` with two live sessions (design §2/§10). Lists the
// candidates and names the recovery move. NOTE: the "any tool but
// wait_for_pause" carve-out is the §6 end-state — raced wait_for_pause lands in
// LEO-365; until then wait_for_pause is ambiguous like every other tool.
export const ambiguousSession = (candidates: readonly SessionCandidate[]) =>
  new ToolError(
    "ambiguous_session",
    `Multiple sessions are live — pass \`session\` to choose one (or call list_sessions). Live sessions: ${formatCandidates(candidates)}.`,
  );

// Explicit `session` that doesn't resolve to a live session (design §2/§10).
// Echoes the bad id and lists what IS live, so a closed or mistyped id gets
// recovery instead of a bare miss.
export const unknownSession = (badId: string, candidates: readonly SessionCandidate[]) =>
  new ToolError(
    "unknown_session",
    `No live session ${JSON.stringify(badId)}. Live sessions: ${formatCandidates(candidates)}. Call list_sessions to see them.`,
  );

// Launch/attach with a label already held by a live session (design §3/§10).
// Labels must be unique among live sessions or a transcript where "frontend"
// is ambiguous defeats their purpose.
export const duplicateLabel = (label: string, clashingId: string) =>
  new ToolError(
    "duplicate_label",
    `Label ${JSON.stringify(label)} is already used by session ${clashingId}. Choose a different label or close that session first.`,
  );

// Thrown by requireCapable() when a tool is invoked against a session kind
// it doesn't support (e.g. select_target on a Node session, or
// get_node_output on a browser session). The message is deliberately
// agent-readable — it names the tool, the kind(s) it requires, AND the
// current kind so the model can recover (e.g. by closing and relaunching
// as the other kind).
//
// `allowed` is the same set TOOL_KIND_SUPPORT[tool] holds. For the v1
// capability matrix, every entry is a single-kind set (BROWSER_ONLY or
// NODE_ONLY); `Array.from(...).join(" or ")` future-proofs the message
// for multi-kind allowlists without changing the v1 wording.
export const unsupportedTarget = (
  tool: string,
  kind: "browser" | "node",
  allowed: ReadonlySet<"browser" | "node">,
) => {
  const needed = Array.from(allowed).join(" or ");
  return new ToolError(
    "unsupported_target",
    `Tool ${tool} requires a ${needed} session (current session is ${kind})`,
  );
};
