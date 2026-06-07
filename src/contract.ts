/**
 * Public package contract, published under the `cdp-mcp/contract` subpath export.
 *
 * Keep this a thin, side-effect-free barrel: it must only re-export from modules
 * (like `./locator.js`) whose import graph never reaches the CLI/server entry
 * (`./index.js`, `./server.js`, `./session/*`). That guarantee is what lets a
 * downstream consumer `import { locatorSchema } from "cdp-mcp/contract"` without
 * dragging in the executable's transport/shebang side effects.
 */
export {
  LocatorError,
  locatorBySchema,
  locatorShape,
  locatorSchema,
  normalizeLocator,
  parseLocator,
  serializeLocator,
} from "./locator.js";
export type { LocatorBy, LocatorSpec } from "./locator.js";
