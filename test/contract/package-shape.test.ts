import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The published cdp-mcp compat wrapper (wrapper/cdp-mcp/bin.js) boots the
// server by resolving this package's exports["."] entry and running it as the
// CLI entry point. That only works while the bin target and the main export
// are the same file — pin the equality so a future bin/library split can't
// silently turn the published wrapper into a start-nothing no-op.
describe("package shape — cdp-mcp wrapper contract", () => {
  it("bin target and exports['.'] entry are the same file", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string>; exports: Record<string, { import: string }> };
    expect(pkg.bin.lynceus).toBe("dist/index.js");
    expect(pkg.exports["."].import).toBe(`./${pkg.bin.lynceus}`);
  });
});
