import type { FrameworkAdapter } from "./adapter.js";

// Configuration-only singleton: this object carries no browser or React
// bridge state. Mutable framework data is always stored on SessionState.
export const reactFrameworkAdapter = Object.freeze({
  framework: "react",
}) satisfies FrameworkAdapter;
