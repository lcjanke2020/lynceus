import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registry, requireSession, type Session } from "../session/state.js";
import { noSession, ToolError } from "../util/errors.js";
import { truncate } from "../util/format.js";
import { registerJsonTool } from "./_register.js";

const EVENT_TYPES = ["console", "network", "node_output"] as const;
type TimelineEventType = (typeof EVENT_TYPES)[number];

interface TimelineSource {
  session: string;
  label: string | null;
  state: Session;
}

interface TimelineRowBase {
  seq: number;
  ts: number;
  session: string;
  label: string | null;
}

type TimelineRow =
  | (TimelineRowBase & {
      event_type: "console";
      level: "log" | "info" | "warn" | "error" | "debug" | "trace" | "verbose";
      source: "console-api" | "runtime-exception";
      text: string;
      file?: string;
      line?: number;
      column?: number;
      js_url?: string;
      js_line?: number;
    })
  | (TimelineRowBase & {
      event_type: "network";
      request_id: string;
      session_id: string | null;
      method: string;
      url: string;
      resource_type?: string;
    })
  | (TimelineRowBase & {
      event_type: "node_output";
      stream: "stdout" | "stderr";
      text: string;
    });

export function registerTimelineTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_timeline",
    'Read console, browser-network request-start, and Node stdout/stderr events in one registry-global sequence. Use `session: "all"` for a merged dual-target view. Pagination is forward: pass the returned cursor as `since` to continue without skipping retained rows.',
    {
      session: z
        .string()
        .optional()
        .describe(
          'Debug-target session id from launch/attach/list_sessions, or the reserved value "all" for every live session. Omit to address the only live session; omission with multiple live sessions is ambiguous.',
        ),
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      event_types: z
        .array(z.enum(EVENT_TYPES))
        .optional()
        .describe(
          "Filter to console, network request-start, and/or node_output rows. Defaults to all three; an empty array is invalid.",
        ),
    },
    async (input: {
      session?: string;
      since?: number;
      limit?: number;
      event_types?: TimelineEventType[];
    }) => {
      if (input.event_types?.length === 0) {
        throw new ToolError(
          "invalid_arg",
          "event_types must contain at least one of: console, network, node_output",
        );
      }

      const sources = resolveTimelineSources(input.session);
      const selected = new Set<TimelineEventType>(input.event_types ?? EVENT_TYPES);
      const since = input.since ?? 0;
      const rows: TimelineRow[] = [];

      for (const source of sources) {
        const base = (seq: number, ts: number): TimelineRowBase => ({
          seq,
          ts,
          session: source.session,
          label: source.label,
        });

        if (selected.has("console")) {
          for (const entry of source.state.console.query({ since })) {
            rows.push({
              ...base(entry.seq, entry.ts),
              event_type: "console",
              level: entry.level,
              source: entry.source,
              text: truncate(entry.text, 1000),
              file: entry.mappedFile,
              line: entry.mappedLine,
              column: entry.mappedColumn,
              js_url: entry.url,
              js_line: entry.lineNumber != null ? entry.lineNumber + 1 : undefined,
            });
          }
        }

        if (selected.has("network")) {
          for (const entry of source.state.network.query({ since })) {
            // A network buffer row is assigned its seq at requestWillBeSent,
            // then response/finish metadata mutates in place. Timeline rows
            // intentionally expose only the immutable request-start snapshot;
            // get_network_requests owns current lifecycle/status reads.
            rows.push({
              ...base(entry.seq, entry.ts),
              event_type: "network",
              request_id: entry.requestId,
              session_id: entry.sessionId ?? null,
              method: entry.method,
              url: entry.url,
              resource_type: entry.resourceType,
            });
          }
        }

        if (selected.has("node_output")) {
          for (const entry of source.state.nodeOutput.query({ since })) {
            rows.push({
              ...base(entry.seq, entry.ts),
              event_type: "node_output",
              stream: entry.stream,
              text: truncate(entry.text, 1000),
            });
          }
        }
      }

      // Forward pagination is deliberate: take the earliest retained rows
      // after `since`, not the existing readers' latest-N tail window. A
      // single noisy stream can fill a page, but the next cursor continues
      // exactly where this page stopped.
      rows.sort((a, b) => a.seq - b.seq);
      const items = rows.slice(0, input.limit ?? 100);
      return {
        cursor: items.length > 0 ? items[items.length - 1]!.seq : since,
        items,
      };
    },
  );
}

function resolveTimelineSources(address?: string): TimelineSource[] {
  if (address === "all") {
    const sources: TimelineSource[] = [];
    for (const summary of registry.list()) {
      const state = registry.get(summary.session);
      if (state?.client) {
        sources.push({ session: summary.session, label: summary.label, state });
      }
    }
    if (sources.length === 0) throw noSession();
    return sources;
  }

  const state = requireSession(address);
  const summary = registry
    .list()
    .find((candidate) => registry.get(candidate.session) === state);
  // requireSession resolved an active registry state synchronously, so the
  // matching summary must exist; keep the guard explicit for invariant drift.
  if (!summary) {
    throw new Error("invariant: resolved timeline session is not in registry.list()");
  }
  return [{ session: summary.session, label: summary.label, state }];
}
