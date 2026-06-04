export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const noSession = () =>
  new ToolError(
    "no_session",
    "No browser session. Call launch_chrome or attach_chrome first.",
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
