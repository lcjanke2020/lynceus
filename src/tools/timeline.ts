import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  ConsoleEntry,
  NetworkEntry,
  NodeOutputEntry,
} from "../session/buffers.js";
import { registry, requireSession, type Session } from "../session/state.js";
import { noSession, ToolError } from "../util/errors.js";
import { truncate } from "../util/format.js";
import { registerJsonTool } from "./_register.js";
import { TIMELINE_SESSION_DESC } from "./_session_input.js";

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

type TimelineCandidate =
  | {
      event_type: "console";
      source: TimelineSource;
      entry: ConsoleEntry;
    }
  | {
      event_type: "network";
      source: TimelineSource;
      entry: NetworkEntry;
    }
  | {
      event_type: "node_output";
      source: TimelineSource;
      entry: NodeOutputEntry;
    };

export function registerTimelineTools(server: McpServer) {
  registerJsonTool(
    server,
    "get_timeline",
    'Read console, browser-network request-start, and Node stdout/stderr events in one registry-global sequence. Use `session: "all"` for a merged dual-target view. Forward pagination is lossless while the `session` and `event_types` selection stays unchanged: pass the returned cursor as `since` to continue.',
    {
      session: z
        .string()
        .optional()
        .describe(TIMELINE_SESSION_DESC),
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Exclusive registry-global seq cursor. Reuse a returned cursor with the same session and event_types selection to avoid skipping retained rows.",
        ),
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
      const limit = input.limit ?? 100;
      const candidates: TimelineCandidate[] = [];

      for (const source of sources) {
        if (selected.has("console")) {
          for (const entry of source.state.console.query({ since }).slice(0, limit)) {
            candidates.push({ event_type: "console", source, entry });
          }
        }

        if (selected.has("network")) {
          for (const entry of source.state.network.query({ since }).slice(0, limit)) {
            candidates.push({ event_type: "network", source, entry });
          }
        }

        if (selected.has("node_output")) {
          for (const entry of source.state.nodeOutput.query({ since }).slice(0, limit)) {
            candidates.push({ event_type: "node_output", source, entry });
          }
        }
      }

      // Forward pagination is deliberate: take the earliest retained rows
      // after `since`, not the existing readers' latest-N tail window. A
      // single noisy stream can fill a page, but the next cursor continues
      // exactly where this page stopped. No buffer can contribute more than
      // `limit` rows to the merged page, so each forward source was capped
      // before this merge. Do not pass limit to RingBuffer.query(): that API
      // deliberately returns the latest-N tail, not the forward head.
      candidates.sort((a, b) => a.entry.seq - b.entry.seq);
      const items = candidates.slice(0, limit).map(projectTimelineCandidate);
      return {
        cursor: items.length > 0 ? items[items.length - 1]!.seq : since,
        items,
      };
    },
  );
}

function projectTimelineCandidate(candidate: TimelineCandidate): TimelineRow {
  const { source, entry } = candidate;
  const base: TimelineRowBase = {
    seq: entry.seq,
    ts: entry.ts,
    session: source.session,
    label: source.label,
  };

  switch (candidate.event_type) {
    case "console":
      return {
        ...base,
        event_type: "console",
        level: candidate.entry.level,
        source: candidate.entry.source,
        text: truncate(candidate.entry.text, 1000),
        file: candidate.entry.mappedFile,
        line: candidate.entry.mappedLine,
        column: candidate.entry.mappedColumn,
        js_url: candidate.entry.url,
        js_line:
          candidate.entry.lineNumber != null
            ? candidate.entry.lineNumber + 1
            : undefined,
      };
    case "network":
      // A network buffer row is assigned its seq at requestWillBeSent, then
      // response/finish metadata mutates in place. Timeline rows intentionally
      // expose only the immutable request-start snapshot;
      // get_network_requests owns current lifecycle/status reads.
      return {
        ...base,
        event_type: "network",
        request_id: candidate.entry.requestId,
        session_id: candidate.entry.sessionId ?? null,
        method: candidate.entry.method,
        url: candidate.entry.url,
        resource_type: candidate.entry.resourceType,
      };
    case "node_output":
      return {
        ...base,
        event_type: "node_output",
        stream: candidate.entry.stream,
        text: truncate(candidate.entry.text, 1000),
      };
  }
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
