import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveFrameworkAdapter } from "../framework/adapter.js";
import { inspectReactComponent } from "../framework/react.js";
import {
  requireCapable,
  requireReactBridge,
  requireSession,
} from "../session/state.js";
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
    "get_react_tree",
    "Return the addressed main frame's current server-materialized React component tree. Includes generation-scoped component and renderer ids, stable paths, component metadata, explicit truncation, and non-fatal production-build warnings. Call attach_react_devtools first.",
    {
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("Maximum descendant depth below each React root (default 6, hard maximum 20). Root depth is 0."),
      max_children: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum children returned per component (default 50, hard maximum 200). Omitted children are counted explicitly."),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(2_000)
        .optional()
        .describe("Maximum components returned across all roots (default 500, hard maximum 2000)."),
      session: sessionSchema,
    },
    async (
      input: {
        max_depth?: number;
        max_children?: number;
        max_nodes?: number;
      } & SessionInput,
    ) => {
      const s = requireSession(input.session);
      requireCapable(s, "get_react_tree");
      const bridge = requireReactBridge(s);
      const snapshot = bridge.tree.snapshot({
        maxDepth: input.max_depth ?? 6,
        maxChildren: input.max_children ?? 50,
        maxNodes: input.max_nodes ?? 500,
      });
      return {
        ...snapshot,
        bridge_generation: bridge.generation,
        document_generation: bridge.documentGeneration,
      };
    },
  );

  registerJsonTool(
    server,
    "find_react_component",
    "Search the addressed main frame's current materialized React tree by display name. Results are deterministic, bounded, and include component_id, renderer_id, and stable tree path for inspect_react_component.",
    {
      name: z
        .string()
        .min(1)
        .max(200)
        .describe("Display name to search for. Matching is a case-insensitive substring by default."),
      exact: z
        .boolean()
        .optional()
        .describe("Require the complete display name to match (default false)."),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Match display-name case exactly (default false)."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum matches returned (default 20, hard maximum 100). total_matches still reports the uncapped count."),
      session: sessionSchema,
    },
    async (
      input: {
        name: string;
        exact?: boolean;
        case_sensitive?: boolean;
        max_results?: number;
      } & SessionInput,
    ) => {
      const s = requireSession(input.session);
      requireCapable(s, "find_react_component");
      const bridge = requireReactBridge(s);
      const result = bridge.tree.find({
        query: input.name,
        exact: input.exact ?? false,
        caseSensitive: input.case_sensitive ?? false,
        limit: input.max_results ?? 20,
      });
      return {
        ...result,
        bridge_generation: bridge.generation,
        document_generation: bridge.documentGeneration,
      };
    },
  );

  registerJsonTool(
    server,
    "inspect_react_component",
    "Pull live props, state, hooks, context, capabilities, and best-effort original TypeScript source for a component in the addressed main-frame React tree. Values preserve React DevTools dehydration metadata. Pass an optional cleaned path to hydrate it in the same call.",
    {
      component_id: z
        .number()
        .int()
        .positive()
        .describe("Generation-scoped component id returned by get_react_tree or find_react_component."),
      renderer_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Renderer id returned with the component. Required only when the same component id exists in multiple renderers."),
      path: z
        .array(
          z.union([
            z.string().min(1).max(200),
            z.number().int().nonnegative(),
          ]),
        )
        .min(1)
        .max(20)
        .optional()
        .describe("Optional React DevTools cleaned path to hydrate, e.g. [\"props\", \"settings\"]. Use cleaned_paths returned by a prior inspection."),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(30_000)
        .optional()
        .describe("Maximum time per inspectElement round-trip (default 5000 ms). Path hydration uses a second round-trip."),
      session: sessionSchema,
    },
    async (
      input: {
        component_id: number;
        renderer_id?: number;
        path?: Array<string | number>;
        timeout_ms?: number;
      } & SessionInput,
    ) => {
      const s = requireSession(input.session);
      requireCapable(s, "inspect_react_component");
      const bridge = requireReactBridge(s);
      return await inspectReactComponent(s, bridge, {
        componentId: input.component_id,
        ...(input.renderer_id !== undefined ? { rendererId: input.renderer_id } : {}),
        ...(input.path !== undefined ? { path: input.path } : {}),
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
