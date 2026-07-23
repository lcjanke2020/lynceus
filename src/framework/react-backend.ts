import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const REACT_DEVTOOLS_CORE_VERSION = "7.0.1";

let cachedBackendSource: string | null = null;

/**
 * Read the exact published UMD backend without executing it in lynceus's Node
 * process. `react-devtools-core` declares dist/backend.js as its main entry,
 * so createRequire.resolve remains valid in source checkouts and installed npm
 * packages alike. The dependency is exact-pinned: this bundle is the Fiber ABI
 * adapter verified across React 16.8–19 by the RDT spikes.
 */
export function getReactBackendSource(): string {
  if (cachedBackendSource !== null) return cachedBackendSource;
  const require = createRequire(import.meta.url);
  const backendPath = require.resolve("react-devtools-core");
  const source = readFileSync(backendPath, "utf8");
  if (
    !source.includes("ReactDevToolsBackend") ||
    !source.includes("connectWithCustomMessagingProtocol")
  ) {
    throw new Error(
      `react-devtools-core@${REACT_DEVTOOLS_CORE_VERSION} backend did not expose the expected bridge API`,
    );
  }
  // The published bundle points at a sibling backend.js.map that is not part
  // of lynceus's injected virtual URL. Strip that terminal directive so the
  // source-map loader does not issue a guaranteed-failing fetch on every
  // attachment; the stable virtual sourceURL still makes page exceptions
  // attributable to this exact backend version.
  const withoutSourceMap = source.replace(
    /\n\/\/# sourceMappingURL=backend\.js\.map\s*$/,
    "",
  );
  cachedBackendSource =
    `${withoutSourceMap}\n//# sourceURL=lynceus://react-devtools-core-${REACT_DEVTOOLS_CORE_VERSION}/backend.js`;
  return cachedBackendSource;
}
