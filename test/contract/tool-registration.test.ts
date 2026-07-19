// Phase F contract test: drive the real MCP server through InMemoryTransport
// (recommended over the getRegisteredHandlers debug helper per Opus M-2).
//
// What this validates that the per-tool L2 tests do NOT:
//   - Every tool registers with a non-empty description.
//   - Every input schema parses through Zod without throwing.
//   - The structured {error, message} envelope survives the full round trip
//     through the SDK's content/result framing — not just the inner handler's
//     direct return.
//   - The exact total tool count matches the documented surface
//     (EXPECTED_TOOL_COUNT, derived from EXPECTED_TOOL_NAMES below).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../../src/server.js";
import { resetSessions } from "../setup.js";

// The documented tool surface. EXPECTED_TOOL_COUNT is DERIVED from this list so
// a new tool bumps the count and the name-set in one edit — no separate literal
// to forget (design §12 anti-drift note; the count was a bare `52` before PR 4).
const EXPECTED_TOOL_NAMES = [
  // session
  "launch_chrome", "attach_chrome", "attach_node", "launch_node", "close_session", "list_sessions", "list_targets", "select_target",
  // nav
  "navigate", "reload", "get_url",
  // source
  "list_scripts", "get_script_source", "get_source", "resolve_source_position",
  // breakpoints
  "set_breakpoint", "remove_breakpoint", "list_breakpoints", "set_pause_on_exceptions",
  // execution
  "resume", "step_over", "step_into", "step_out", "pause", "wait_for_pause",
  // inspect
  "get_call_stack", "get_scope", "evaluate", "get_object_properties",
  // console
  "get_console_logs", "clear_console",
  // network
  "get_network_requests", "get_request_body", "get_response_body",
  // dom
  "query_selector", "get_element_html", "locate", "wait_for", "get_form_state",
  "click", "type_text", "press_key", "screenshot",
  // forms
  "select_option", "check", "uncheck", "fill", "suggest_locator",
  // storage
  "export_storage_state", "load_storage_state", "get_cookies", "set_cookies",
  // node-output
  "get_node_output",
];
const EXPECTED_TOOL_COUNT = EXPECTED_TOOL_NAMES.length;

const SESSION_ADDRESS_EXEMPT = new Set([
  "launch_chrome",
  "attach_chrome",
  "attach_node",
  "launch_node",
  "list_sessions",
]);
const SESSION_ADDRESSED_TOOL_NAMES = EXPECTED_TOOL_NAMES.filter(
  (name) => !SESSION_ADDRESS_EXEMPT.has(name),
);

const CHILD_SESSION_ID_TOOL_NAMES = [
  "get_object_properties",
  "get_request_body",
  "get_response_body",
  "pause",
  "get_source",
  "get_script_source",
  "select_option",
  "fill",
  "check",
  "uncheck",
  "suggest_locator",
];

let client: Client;

beforeAll(async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverT);
  client = new Client({ name: "contract-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientT);
});

afterAll(async () => {
  await client?.close();
  resetSessions();
});

describe("tools/list", () => {
  it(`returns exactly ${EXPECTED_TOOL_COUNT} tools (the documented surface)`, async () => {
    const r = await client.listTools();
    expect(r.tools).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("every tool has a non-empty description", async () => {
    const r = await client.listTools();
    const missing = r.tools.filter((t) => !t.description || t.description.length === 0);
    expect(missing).toEqual([]);
  });

  it("includes the documented set of tool names", async () => {
    const r = await client.listTools();
    const names = new Set(r.tools.map((t) => t.name));
    // Bidirectional check: every expected name is present AND no unexpected
    // name is registered. The exact-count check above catches accidental
    // additions, but a renamed tool could still pass `has(name)` for one
    // expected entry while a stale entry remains in EXPECTED_TOOL_NAMES.
    // Set equality catches both directions in one assertion.
    // (Opus PR #10 round-2 Low.)
    expect(names).toEqual(new Set(EXPECTED_TOOL_NAMES));
  });

  it("inputSchemas are valid JSON Schema (parseable + 'type:object' shape)", async () => {
    const r = await client.listTools();
    for (const tool of r.tools) {
      // Tools with no inputs (close_session, list_targets, …) emit a schema
      // anyway since registerTool always provides one — verify they're still
      // well-formed.
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("every addressed tool exposes the debug-target session selector", async () => {
    const r = await client.listTools();
    const byName = new Map(r.tools.map((tool) => [tool.name, tool]));
    expect(SESSION_ADDRESSED_TOOL_NAMES).toHaveLength(48); // 47 ordinary tools + close_session
    for (const name of SESSION_ADDRESSED_TOOL_NAMES) {
      const schema = byName.get(name)?.inputSchema as any;
      expect(schema?.properties?.session, `${name} is missing session`).toBeDefined();
      expect(schema.properties.session.description).toContain("Debug-target session id");
    }
  });

  it("all 11 child-session-aware tools expose both axes and the shared disambiguation", async () => {
    const r = await client.listTools();
    const byName = new Map(r.tools.map((tool) => [tool.name, tool]));
    expect(CHILD_SESSION_ID_TOOL_NAMES).toHaveLength(11);
    for (const name of CHILD_SESSION_ID_TOOL_NAMES) {
      const tool = byName.get(name)!;
      const schema = tool.inputSchema as any;
      expect(schema.properties.session, `${name} is missing session`).toBeDefined();
      expect(schema.properties.session_id, `${name} is missing session_id`).toBeDefined();
      expect(schema.properties.session_id.description).toContain(
        "distinct from `session`",
      );
      expect(tool.description).toContain("`session` selects");
      expect(tool.description).toContain("`session_id` selects");
    }
  });
});

describe("tools/list_changed nudge on startup (issue #1)", () => {
  // The high-level McpServer advertises `tools: { listChanged: true }` but the
  // SDK never emits the notification on its own. buildServer() wires an
  // oninitialized hook to send it once, so clients that gate their first
  // tools/list on a list_changed (e.g. Copilot CLI over SSE) don't hang.
  // The handler must be registered BEFORE connect(), since the notification is
  // emitted in response to the client's `initialized` — so this needs its own
  // client/server pair rather than the shared one from beforeAll.
  it("server emits notifications/tools/list_changed after the client initializes", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    await server.connect(serverT);

    const localClient = new Client({ name: "list-changed-test", version: "0.0.1" }, { capabilities: {} });
    const notified = new Promise<void>((resolve) => {
      localClient.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve());
    });

    try {
      await localClient.connect(clientT);
      // connect() completes the initialize handshake and sends `initialized`,
      // which triggers the server-side notification. Bound the wait so a
      // regression fails fast instead of hanging to the suite timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no tools/list_changed within 2s")), 2000);
      });
      try {
        await Promise.race([notified, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      await localClient.close();
      await server.close();
    }
  });
});

describe("tools/call — error envelope round-trip via the full SDK transport", () => {
  // These tools require an active session. With no session, every one of
  // them must surface the structured {error: "no_session", message: ...}
  // payload through the SDK's content/result framing — not just the inner
  // handler's direct return shape.
  //
  // Using a representative subset (one per category) rather than all 52 to
  // keep the contract test fast.
  const noSessionCases: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: "navigate", args: { url: "http://x" } },
    { tool: "list_scripts", args: {} },
    { tool: "set_breakpoint", args: { file: "src/x.ts", line: 1 } },
    { tool: "resume", args: {} },
    { tool: "get_call_stack", args: {} },
    { tool: "get_console_logs", args: {} },
    { tool: "get_network_requests", args: {} },
    { tool: "query_selector", args: { selector: "#x" } },
    { tool: "get_cookies", args: {} },
  ];

  for (const { tool, args } of noSessionCases) {
    it(`${tool}: returns isError envelope with {error: "no_session", message: ...}`, async () => {
      resetSessions(); // ensure no client
      const result = await client.callTool({ name: tool, arguments: args });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed.error).toBe("no_session");
      expect(typeof parsed.message).toBe("string");
      expect(parsed.message.length).toBeGreaterThan(0);
    });
  }
});

describe("tools/call — schema validation rejects malformed input", () => {
  it("set_breakpoint: missing required 'file' is rejected before reaching the handler", async () => {
    resetSessions();
    // Missing 'file' (required string). The SDK should reject via Zod
    // before the handler runs, surfacing as either a thrown error or
    // an isError envelope — either is acceptable evidence of validation.
    let threw = false;
    let result: any = null;
    try {
      result = await client.callTool({ name: "set_breakpoint", arguments: { line: 5 } });
    } catch {
      threw = true;
    }
    if (!threw) {
      // If the SDK chose to wrap rather than throw, the envelope must mark error.
      expect(result?.isError).toBe(true);
    } else {
      expect(threw).toBe(true);
    }
  });

  it("set_breakpoint: line:0 is rejected (zod requires positive int)", async () => {
    resetSessions();
    let threw = false;
    let result: any = null;
    try {
      result = await client.callTool({
        name: "set_breakpoint",
        arguments: { file: "src/x.ts", line: 0 },
      });
    } catch {
      threw = true;
    }
    if (!threw) {
      expect(result?.isError).toBe(true);
    } else {
      expect(threw).toBe(true);
    }
  });

  it("clear_console (no args required): handler dispatches without arg-validation rejection — surfaces no_session error envelope, not a transport-level reject", async () => {
    resetSessions();
    const result = await client.callTool({ name: "clear_console", arguments: {} });
    // No session → still expects no_session error envelope, not a transport-level reject.
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]!.text).error).toBe("no_session");
  });

  it("session_id rejects a debug-target id and points the caller to session", async () => {
    resetSessions();
    let message = "";
    try {
      const result = await client.callTool({
        name: "pause",
        arguments: { session_id: "browser_1" },
      });
      message = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("browser_1");
    expect(message).toContain("pass it as `session`");
    expect(message).toContain("not `session_id`");
  });

  it("forms accept explicit null session_id as the root sentinel", async () => {
    resetSessions();
    const result = await client.callTool({
      name: "fill",
      arguments: {
        by: "css",
        css: "#name",
        value: "Ada",
        session_id: null,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    // Accepted by Zod and reached the handler; only the absent debug target failed.
    expect(JSON.parse(content[0]!.text).error).toBe("no_session");
  });
});
