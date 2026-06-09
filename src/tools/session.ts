import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { launchChrome, attachChrome, closeSession, switchTarget } from "../session/browser.js";
import { getSession, requireSession } from "../session/state.js";
import { registerJsonTool } from "./_register.js";

export function registerSessionTools(server: McpServer) {
  registerJsonTool(
    server,
    "launch_chrome",
    "Launch a new Chrome instance with remote debugging and attach. Returns the active target.",
    {
      url: z.string().optional().describe("Initial URL to load (default: about:blank)"),
      headless: z.boolean().optional().describe("Run headless"),
      user_data_dir: z.string().optional().describe("Profile dir"),
      args: z.array(z.string()).optional().describe("Extra chrome flags"),
      chrome_path: z
        .string()
        .optional()
        .describe(
          "Optional explicit path to a Chrome/Chromium binary. Omit by default — chrome-launcher auto-detects (on Linux it searches PATH for google-chrome-stable, google-chrome, chromium-browser, chromium). Pass this only if a previous call failed because chrome-launcher could not find a binary.",
        ),
      sandbox: z
        .boolean()
        .optional()
        .describe(
          "Enable Chromium's sandbox. When omitted, defaults from the CDP_SANDBOX env (default false → we add --no-sandbox). On Ubuntu 23.10+ AppArmor restricts the unprivileged user namespace Chromium's sandbox depends on, so unsandboxed launch is the working default for automation. Pass true only on a host with a working sandbox path (AppArmor userns allowance or SUID chrome_sandbox helper).",
        ),
    },
    async (input: {
      url?: string;
      headless?: boolean;
      user_data_dir?: string;
      args?: string[];
      chrome_path?: string;
      sandbox?: boolean;
    }) => {
      return await launchChrome({
        url: input.url,
        headless: input.headless,
        userDataDir: input.user_data_dir,
        args: input.args,
        chromePath: input.chrome_path,
        sandbox: input.sandbox,
      });
    },
  );

  registerJsonTool(
    server,
    "attach_chrome",
    "Attach to an already-running Chrome started with --remote-debugging-port. Picks the first matching page.",
    {
      port: z.number().int().positive().optional().describe("Default 9222"),
      host: z.string().optional(),
      target_filter: z
        .object({
          type: z.string().optional(),
          url_includes: z.string().optional(),
        })
        .optional(),
    },
    async (input: { port?: number; host?: string; target_filter?: { type?: string; url_includes?: string } }) => {
      return await attachChrome({
        port: input.port,
        host: input.host,
        targetFilter: input.target_filter
          ? {
              ...(input.target_filter.type ? { type: input.target_filter.type } : {}),
              ...(input.target_filter.url_includes ? { urlIncludes: input.target_filter.url_includes } : {}),
            }
          : undefined,
      });
    },
  );

  registerJsonTool(
    server,
    "close_session",
    "Close the active CDP session. Kills the browser if we launched it; leaves it alone if we attached.",
    undefined,
    async () => {
      if (!getSession()) return "no active session";
      await closeSession();
      return "closed";
    },
  );

  registerJsonTool(
    server,
    "list_targets",
    "List all debuggable targets on the current browser (pages, workers, iframes).",
    undefined,
    async () => {
      const s = requireSession();
      const targets = await CDP.List({ port: s.chromePort! });
      return targets.map((t) => ({
        id: t.id,
        type: t.type,
        url: t.url,
        title: t.title,
        active: t.id === s.currentTargetId,
      }));
    },
  );

  registerJsonTool(
    server,
    "select_target",
    "Switch the active page target. Closes the current CDP socket and opens a new one.",
    { id: z.string().describe("Target ID from list_targets") },
    async (input: { id: string }) => {
      const s = requireSession();
      if (s.currentTargetId === input.id) return { id: input.id, status: "already-active" };
      const r = await switchTarget(input.id);
      return { id: r.targetId, url: r.url, status: "switched" };
    },
  );
}
