import type { Protocol } from "devtools-protocol";

export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: "log" | "info" | "warn" | "error" | "debug" | "trace" | "verbose";
  text: string;
  source: "console-api" | "runtime-exception";
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  // Source-mapped location (TS), set by buffer wirer when available.
  mappedFile?: string;
  mappedLine?: number;
  mappedColumn?: number;
  stack?: Protocol.Runtime.StackTrace;
}

export interface NetworkEntry {
  seq: number;
  requestId: string;
  ts: number;
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  durationMs?: number;
  failureReason?: string;
  // True once Network.loadingFinished / loadingFailed has fired — i.e.,
  // the request lifecycle is complete. get_response_body is safe ONLY
  // when both `finished: true` AND `failureReason` is undefined; failed
  // requests are also `finished: true` but have no body.
  finished?: boolean;
  // Flat-session ID this request was observed in. undefined = top page.
  // Required to route get_response_body / get_request_body to the right
  // CDP Network agent (requestIds are per-agent, not global).
  sessionId?: string;
  // Bodies are NOT stored; fetch on demand via get_request_body/get_response_body.
}

export class RingBuffer<T extends { seq: number }> {
  private items: T[] = [];
  private nextSeq = 1;
  constructor(private capacity: number) {}

  push(item: Omit<T, "seq">): T {
    const full = { ...(item as object), seq: this.nextSeq++ } as T;
    this.items.push(full);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    return full;
  }

  query(opts: {
    since?: number;
    limit?: number;
    filter?: (item: T) => boolean;
  } = {}): T[] {
    const since = opts.since ?? 0;
    let out = this.items.filter((it) => it.seq > since);
    if (opts.filter) out = out.filter(opts.filter);
    if (opts.limit !== undefined) out = out.slice(-opts.limit);
    return out;
  }

  clear() {
    this.items = [];
  }

  size() {
    return this.items.length;
  }

  // Mutate-in-place: used by network buffer to update an entry when the response arrives.
  update(predicate: (item: T) => boolean, patch: Partial<T>): T | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (predicate(item)) {
        this.items[i] = { ...item, ...patch };
        return this.items[i]!;
      }
    }
    return null;
  }
}
