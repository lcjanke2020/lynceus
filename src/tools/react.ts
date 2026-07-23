import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveFrameworkAdapter } from "../framework/adapter.js";
import { requireCapable, requireSession } from "../session/state.js";
import { registerJsonTool } from "./_register.js";
import { sessionSchema, type SessionInput } from "./_session_input.js";

export function registerReactTools(server: McpServer): void {
  registerJsonTool(
    server,
    "attach_react_devtools",
    "Attach the embedded React DevTools backend to the addressed browser session. Reloads the page so the backend installs before React, then waits for the main-frame bootstrap and first component-tree operations event. V1 inspects the main-frame React tree only; iframe bridge traffic is ignored.",
    {
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .optional()
        .describe("Maximum time to wait for the bootstrap sentinel and first React operations event (default 10000 ms)."),
      session: sessionSchema,
    },
    async (input: { timeout_ms?: number } & SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "attach_react_devtools");
      return await resolveFrameworkAdapter("react").attach(s, {
        ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    "detach_react_devtools",
    "Detach React DevTools from the addressed browser session. Unsubscribes the in-page backend, removes future-document injection and CDP binding registrations, clears buffered React state, and fences late events. Idempotent when no bridge is attached.",
    { session: sessionSchema },
    async (input: SessionInput) => {
      const s = requireSession(input.session);
      requireCapable(s, "detach_react_devtools");
      return await resolveFrameworkAdapter("react").detach(s);
    },
  );
}
