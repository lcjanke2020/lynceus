import { ToolError } from "../util/errors.js";
import type { Session } from "../session/state.js";
import { reactFrameworkAdapter } from "./react.js";

export type FrameworkName = "react";

// Framework-neutral dispatch seam. Adapter instances are stateless; all
// mutable bridge data belongs to the addressed SessionState, so callers can
// resolve a framework without coupling tool code to React modules.
export interface FrameworkAdapter {
  readonly framework: FrameworkName;
  attach(
    session: Session,
    opts?: { timeoutMs?: number },
  ): Promise<FrameworkAttachResult>;
  detach(session: Session): Promise<FrameworkDetachResult>;
}

export interface FrameworkAttachResult {
  framework: FrameworkName;
  status: "attached" | "already-attached";
  generation: number;
  backend_version: string;
  events_buffered: number;
}

export interface FrameworkDetachResult {
  framework: FrameworkName;
  status: "detached" | "not-attached";
  // Current post-detach epoch. It is intentionally newer than the generation
  // of the bridge that was torn down.
  generation: number;
}

export function resolveFrameworkAdapter(framework: string): FrameworkAdapter {
  const normalized = framework.trim().toLowerCase();
  if (normalized === "react") return reactFrameworkAdapter;

  throw new ToolError(
    "unsupported_framework",
    `Unsupported framework ${JSON.stringify(framework)}. Supported frameworks: react.`,
  );
}
