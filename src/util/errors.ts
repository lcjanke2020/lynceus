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

export const alreadySession = () =>
  new ToolError(
    "already_session",
    "A session is already active. Call close_session before opening a new one.",
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
