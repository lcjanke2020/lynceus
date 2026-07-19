import { z } from "zod";

// Debug-target addressing (browser_1 / node_1) is deliberately distinct
// from CDP's child-session axis (`session_id`). Keep both schemas and their
// agent-facing wording in one place so the 47 session-scoped tools and the
// 11 child-session-aware tools cannot drift independently.
export const SESSION_DESC =
  'Debug-target session id from launch/attach/list_sessions (for example "browser_1" or "node_1"). Omit to address the only live session; when multiple are live, pass one explicitly.';

export const sessionSchema = z.string().optional().describe(SESSION_DESC);

export interface SessionInput {
  session?: string;
}

export const CHILD_SESSION_ID_DESC =
  "CDP child-session id from the originating tool response (worker/iframe/OOPIF). null or omitted = the root CDP session. This is distinct from `session`, which selects the browser or Node debug target.";

const DEBUG_TARGET_SESSION_ID = /^(?:browser|node)_\d+$/;

export const childSessionIdSchema = z
  .string()
  .nullable()
  .optional()
  .superRefine((value, ctx) => {
    if (value !== null && value !== undefined && DEBUG_TARGET_SESSION_ID.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${value}" is a debug-target session id; pass it as \`session\`, not \`session_id\`.`,
      });
    }
  })
  .describe(CHILD_SESSION_ID_DESC);

export function withChildSessionDisambiguation(description: string): string {
  return (
    `${description} Addressing: \`session\` selects the browser or Node debug target; ` +
    "`session_id` selects a CDP child (worker/iframe/OOPIF) within that target, and null or omitted means root."
  );
}
