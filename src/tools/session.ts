import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import CDP from "chrome-remote-interface";
import { launchChrome, attachChrome, closeSession, switchTarget } from "../session/browser.js";
import { attachNode, launchNode } from "../session/node.js";
import { getSession, requireSession, requireCapable } from "../session/state.js";
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
          "Enable Chromium's sandbox. When omitted, defaults from the CDP_SANDBOX env ('true' or '1' enable it; default false → we add --no-sandbox). On Ubuntu 23.10+ AppArmor restricts the unprivileged user namespace Chromium's sandbox depends on, so unsandboxed launch is the working default for automation. Pass true only on a host with a working sandbox path (AppArmor userns allowance or SUID chrome_sandbox helper).",
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
    "attach_node",
    "Attach to a Node.js process started with --inspect or --inspect-brk. Discovers the inspector target via the /json/list endpoint at host:port (default 127.0.0.1:9229), enables Runtime + Debugger, and (for --inspect-brk) surfaces the entry pause through wait_for_pause. Does not call Debugger.resume; install breakpoints from the entry pause and call resume() to release the process. Browser-only tools (Page/DOM/Network) are not available against a Node session.",
    {
      port: z.number().int().positive().optional().describe("Inspector port (default 9229)"),
      host: z.string().optional().describe("Inspector host (default 127.0.0.1)"),
    },
    async (input: { port?: number; host?: string }) => {
      return await attachNode({
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    "launch_node",
    "Launch a Node.js script under the inspector and attach. Uses --inspect-brk by default so the entry pause is available for breakpoint setup; close_session terminates the launched process. Child stdin is ignored; stdout/stderr is captured into the durable buffer read via get_node_output. console.* calls inside the debuggee are still captured separately through Runtime.consoleAPICalled (get_console_logs).",
    {
      script: z.string().min(1).describe("Path to the JavaScript entry script. Relative paths resolve against cwd."),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments passed to the script after the script path. Do not include --inspect or --inspect-brk here."),
      cwd: z.string().optional().describe("Working directory for the Node process (default: lynceus process cwd)."),
      env: z
        .record(z.string())
        .optional()
        .describe("Environment variable overrides merged over the lynceus process environment. The launched script inherits other lynceus env vars."),
      inspect_mode: z
        .enum(["inspect", "inspect-brk"])
        .optional()
        .describe("Inspector mode: inspect or inspect-brk (default: inspect-brk)."),
      inspect_port: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Inspector port to request. Omit to let Node pick an available port."),
    },
    async (input: {
      script: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      inspect_mode?: "inspect" | "inspect-brk";
      inspect_port?: number;
    }) => {
      return await launchNode({
        script: input.script,
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.inspect_mode !== undefined ? { inspectMode: input.inspect_mode } : {}),
        ...(input.inspect_port !== undefined ? { inspectPort: input.inspect_port } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    "close_session",
    "Close the active CDP session. Kills the underlying process (Chrome or Node) if we launched it; leaves it alone if we attached.",
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
    "List all debuggable targets: on a browser session, the pages, workers, and iframes; on a Node session, the single root target.",
    undefined,
    async () => {
      const s = requireSession();
      const targets = await CDP.List({ port: s.chromePort!, host: s.chromeHost ?? undefined });
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
      requireCapable(s, "select_target");
      if (s.currentTargetId === input.id) return { id: input.id, status: "already-active" };
      const r = await switchTarget(input.id);
      return { id: r.targetId, url: r.url, status: "switched" };
    },
  );
}
