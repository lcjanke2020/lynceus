import { ToolError } from "../util/errors.js";

export type ReactInspectionPath = Array<string | number>;

export interface ReactInspectionRequest {
  rendererId: number;
  componentId: number;
  path: ReactInspectionPath | null;
  forceFullData: boolean;
  timeoutMs: number;
}

export type ReactInspectionReply =
  | {
      kind: "full-data" | "no-change";
      value: Record<string, unknown>;
    }
  | {
      kind: "hydrated-path";
      path: ReactInspectionPath;
      value: unknown;
    }
  | { kind: "not-found" }
  | {
      kind: "error";
      errorType: string;
      message: string;
      stack?: string;
    };

interface PendingInspection {
  rendererId: number;
  componentId: number;
  path: ReactInspectionPath | null;
  resolve: (reply: ReactInspectionReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const cacheKey = (rendererId: number, componentId: number): string =>
  `${rendererId}:${componentId}`;

/** Correlates inspectElement requests with asynchronous bridge replies. */
export class ReactInspectionCoordinator {
  private nextRequestId = 0;
  private pending = new Map<number, PendingInspection>();
  private cache = new Map<string, Record<string, unknown>>();

  hasCached(rendererId: number, componentId: number): boolean {
    return this.cache.has(cacheKey(rendererId, componentId));
  }

  async request(
    request: ReactInspectionRequest,
    dispatch: (requestId: number) => Promise<void>,
  ): Promise<ReactInspectionReply> {
    const requestId = ++this.nextRequestId;
    let resolveReply!: (reply: ReactInspectionReply) => void;
    let rejectReply!: (error: Error) => void;
    const replyPromise = new Promise<ReactInspectionReply>((resolve, reject) => {
      resolveReply = resolve;
      rejectReply = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.reject(
        new ToolError(
          "react_inspection_timeout",
          `React DevTools did not reply to inspectElement request ${requestId} within ${request.timeoutMs}ms. Retry the inspection or reattach the bridge.`,
        ),
      );
    }, request.timeoutMs);
    this.pending.set(requestId, {
      rendererId: request.rendererId,
      componentId: request.componentId,
      path: request.path === null ? null : [...request.path],
      resolve: resolveReply,
      reject: rejectReply,
      timer,
    });

    try {
      // The pending entry must exist before Runtime.evaluate: fake CDP and a
      // real local binding can deliver inspectedElement synchronously while
      // the evaluate command itself is still resolving.
      await dispatch(requestId);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return await replyPromise;
  }

  handle(payload: unknown): boolean {
    if (!isRecord(payload) || !Number.isSafeInteger(payload.responseID)) return false;
    const requestId = payload.responseID as number;
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    try {
      if (payload.id !== pending.componentId) {
        throw protocolError(
          `inspectElement response ${requestId} returned component ${String(payload.id)} instead of ${pending.componentId}`,
        );
      }
      switch (payload.type) {
        case "full-data": {
          if (!isRecord(payload.value)) {
            throw protocolError(`inspectElement response ${requestId} has invalid full-data value`);
          }
          const value = payload.value;
          this.cache.set(cacheKey(pending.rendererId, pending.componentId), value);
          pending.resolve({ kind: "full-data", value });
          return true;
        }
        case "no-change": {
          const value = this.cache.get(cacheKey(pending.rendererId, pending.componentId));
          if (!value) {
            throw protocolError(
              `inspectElement response ${requestId} reported no-change without a cached full-data response`,
            );
          }
          pending.resolve({ kind: "no-change", value });
          return true;
        }
        case "hydrated-path": {
          if (!isInspectionPath(payload.path)) {
            throw protocolError(`inspectElement response ${requestId} has an invalid hydrated path`);
          }
          if (pending.path === null || !pathsEqual(payload.path, pending.path)) {
            throw protocolError(
              `inspectElement response ${requestId} returned a different hydrated path than requested`,
            );
          }
          pending.resolve({
            kind: "hydrated-path",
            path: payload.path,
            value: payload.value,
          });
          return true;
        }
        case "not-found":
          this.cache.delete(cacheKey(pending.rendererId, pending.componentId));
          pending.resolve({ kind: "not-found" });
          return true;
        case "error":
          pending.resolve({
            kind: "error",
            errorType: typeof payload.errorType === "string" ? payload.errorType : "unknown",
            message:
              typeof payload.message === "string"
                ? payload.message
                : "React DevTools could not inspect this component.",
            ...(typeof payload.stack === "string" ? { stack: payload.stack } : {}),
          });
          return true;
        default:
          throw protocolError(
            `inspectElement response ${requestId} has unsupported type ${JSON.stringify(payload.type)}`,
          );
      }
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return true;
    }
  }

  reset(message: string): void {
    const error = new ToolError("react_inspection_cancelled", message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.cache.clear();
  }
}

export interface ReactDehydratedValue {
  data: unknown;
  cleaned_paths: ReactInspectionPath[];
  unserializable_paths: ReactInspectionPath[];
}

export function normalizeDehydratedValue(
  value: unknown,
  pathPrefix: ReactInspectionPath = [],
): ReactDehydratedValue | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !("data" in value)) {
    throw protocolError("React inspected value is not a dehydrated {data, cleaned, unserializable} envelope");
  }
  const cleaned = normalizePaths(value.cleaned, "cleaned");
  const unserializable = normalizePaths(value.unserializable, "unserializable");
  return {
    data: value.data,
    cleaned_paths: cleaned.map((path) => [...pathPrefix, ...path]),
    unserializable_paths: unserializable.map((path) => [
      ...pathPrefix,
      ...path,
    ]),
  };
}

function normalizePaths(value: unknown, label: string): ReactInspectionPath[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isInspectionPath)) {
    throw protocolError(`React inspected ${label} paths are malformed`);
  }
  return value.map((path) => [...path]);
}

export function isInspectionPath(value: unknown): value is ReactInspectionPath {
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        (typeof part === "string" && part.length > 0) ||
        (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
    )
  );
}

function pathsEqual(left: ReactInspectionPath, right: ReactInspectionPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message: string): ToolError {
  return new ToolError("react_protocol_error", message);
}
