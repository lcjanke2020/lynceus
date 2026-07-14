# cdp-mcp → lynceus

**cdp-mcp has been renamed to [lynceus](https://www.npmjs.com/package/lynceus).**

This package is a thin compatibility wrapper: it depends on lynceus and boots the
lynceus MCP server, so existing `npx cdp-mcp` / `cdp-mcp` setups keep working
unchanged. It receives no independent fixes — new features and bug fixes land in
lynceus only, and the wrapper pins the lynceus 0.4.x line: when a newer lynceus
line ships, the wrapper may lag until republished. Install lynceus directly to
always get the latest.

## Migration (nothing changes except the name)

- Install: `npm install -g lynceus` (or `npx lynceus`)
- MCP config: use `lynceus` as the command, e.g. `claude mcp add lynceus lynceus`
- Environment variables: nothing to change — the old `CDP_MCP_*` names are still
  honored as aliases of `LYNCEUS_*`
- Imports: `import { locatorSchema } from "cdp-mcp/contract"` keeps compiling via
  this wrapper; new code should import from `"lynceus/contract"`
- Repository: <https://github.com/lcjanke2020/lynceus> (GitHub redirects the old
  repo name)

## What lynceus is

A TypeScript-aware runtime debugger that AI agents drive over MCP: one server that
debugs both the browser (Chrome DevTools Protocol) and Node.js (V8 Inspector), with
source-level breakpoints, stepping, frame-aware evaluation, and scope/object
inspection in TS coordinates. See the [lynceus README](https://github.com/lcjanke2020/lynceus#readme).
