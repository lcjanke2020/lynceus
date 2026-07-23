import { ToolError } from "../util/errors.js";
import { reactFrameworkAdapter } from "./react.js";

export type FrameworkName = "react";

// Framework-neutral dispatch seam. PR 1a intentionally keeps this contract
// minimal: bridge lifecycle methods arrive with PR 1b, while callers can
// already resolve a framework without coupling tool code to React modules.
// Adapter instances are stateless; all mutable bridge data belongs to the
// addressed SessionState.
export interface FrameworkAdapter {
  readonly framework: FrameworkName;
}

export function resolveFrameworkAdapter(framework: string): FrameworkAdapter {
  const normalized = framework.trim().toLowerCase();
  if (normalized === "react") return reactFrameworkAdapter;

  throw new ToolError(
    "unsupported_framework",
    `Unsupported framework ${JSON.stringify(framework)}. Supported frameworks: react.`,
  );
}
