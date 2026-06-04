import { describe, it, expect } from "vitest";
import { normalizeSourcePath, pathMatches } from "./normalize.js";

describe("normalizeSourcePath", () => {
  const cases: Array<[string, string]> = [
    ["webpack:///./src/foo.ts", "src/foo.ts"],
    ["webpack-internal:///./src/foo.ts", "src/foo.ts"],
    ["webpack://app/./src/foo.ts", "src/foo.ts"],
    ["webpack:///src/foo.ts", "src/foo.ts"],
    ["./src/foo.ts", "src/foo.ts"],
    ["/src/foo.ts", "src/foo.ts"],
    ["src/foo.ts", "src/foo.ts"],
    ["file:///C:/proj/src/foo.ts", "C:/proj/src/foo.ts"],
    ["file:///home/user/proj/src/foo.ts", "home/user/proj/src/foo.ts"],
    ["rollup://./lib/x.ts", "lib/x.ts"],
    ["vite-fs:///src/x.ts", "src/x.ts"],
    ["src\\foo.ts", "src/foo.ts"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(normalizeSourcePath(input)).toBe(expected);
    });
  }
});

describe("pathMatches", () => {
  it("exact match", () => {
    expect(pathMatches("src/foo.ts", "src/foo.ts")).toBe(true);
  });
  it("strips prefixes before matching", () => {
    expect(pathMatches("webpack:///./src/foo.ts", "src/foo.ts")).toBe(true);
    expect(pathMatches("webpack:///./src/foo.ts", "./src/foo.ts")).toBe(true);
  });
  it("suffix match: candidate has deeper path", () => {
    expect(pathMatches("a/b/src/foo.ts", "foo.ts")).toBe(true);
    expect(pathMatches("a/b/src/foo.ts", "src/foo.ts")).toBe(true);
  });
  it("suffix match: query is more specific than candidate", () => {
    expect(pathMatches("foo.ts", "src/foo.ts")).toBe(true);
  });
  it("rejects mismatched basenames", () => {
    expect(pathMatches("src/foo.ts", "src/bar.ts")).toBe(false);
  });
  it("rejects partial segment match", () => {
    expect(pathMatches("src/foo.ts", "oo.ts")).toBe(false);
  });
});
