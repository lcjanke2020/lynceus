import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSessionTools } from "./tools/session.js";
import { registerNavTools } from "./tools/nav.js";
import { registerSourceTools } from "./tools/source.js";
import { registerBreakpointTools } from "./tools/breakpoints.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerDomTools } from "./tools/dom.js";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "cdp-mcp",
    version: "0.1.0",
  });

  registerSessionTools(server);
  registerNavTools(server);
  registerSourceTools(server);
  registerBreakpointTools(server);
  registerExecutionTools(server);
  registerInspectTools(server);
  registerConsoleTools(server);
  registerNetworkTools(server);
  registerDomTools(server);

  return server;
}
