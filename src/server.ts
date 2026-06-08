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
import { registerFormTools } from "./tools/forms.js";
import { registerStorageTools } from "./tools/storage.js";

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "cdp-mcp",
    version: "0.1.2",
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
  registerFormTools(server);
  registerStorageTools(server);

  // The SDK advertises `tools: { listChanged: true }` as soon as any tool is
  // registered, but never emits the matching notification on its own. Some
  // clients (e.g. GitHub Copilot CLI over SSE) gate their first `tools/list`
  // call on receiving a `notifications/tools/list_changed` and otherwise wait
  // forever — registering zero tools. Emit it once, right after the client's
  // `initialized` (so the transport is connected and the client is ready).
  // Harmless for clients that already fetch eagerly. See issue #1.
  server.server.oninitialized = () => {
    server.sendToolListChanged();
  };

  return server;
}
