// Smoke test for the cdp-mcp compatibility wrapper. Run from this directory
// after `npm install` (pulls the published lynceus this wrapper pins):
//
//   node smoke-test.mjs
//
// Not wired into the root vitest suite: the wrapper depends on the *published*
// lynceus package, not the local build, so it needs its own install step.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// 1. The bin shim reaches the lynceus CLI: --help prints usage and exits 0.
const help = spawnSync(process.execPath, ["bin.js", "--help"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
});
assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
assert.match(help.stderr, /Usage:/, `no usage banner in stderr: ${help.stderr}`);

// 2. The contract subpath re-exports lynceus/contract's runtime surface.
const contract = await import("./contract.js");
assert.ok("locatorSchema" in contract, "contract re-export missing locatorSchema");
assert.ok("parseLocator" in contract, "contract re-export missing parseLocator");

// 3. The main subpath resolves (import must not throw or start the server —
// lynceus's run-as-main guard keeps a plain import side-effect free).
await import("./index.js");

console.log("cdp-mcp wrapper smoke: OK");
