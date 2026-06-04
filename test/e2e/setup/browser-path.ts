// Browser resolver — implementation moved to src/util/browser-resolve.ts so
// the L4 eval harness (evals/harness/runner.ts) can use the same resolution
// path. This file remains as a thin re-export so existing L3 imports in
// test/e2e/setup/global.ts keep working unchanged. See the moved file for
// the full resolution-order doc-comment and rationale.

export {
  resolveBrowser,
  getBrowserChoice,
  isChromeLauncherDefault,
  snapUserDataDir,
  type BrowserChoice,
  type ResolvedBrowser,
} from "../../../src/util/browser-resolve.js";
