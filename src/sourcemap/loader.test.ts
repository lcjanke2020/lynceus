import { describe, it, expect } from "vitest";
import { decodeDataUri } from "./loader.js";

describe("decodeDataUri", () => {
  it("decodes base64 with single content-type parameter (typical CDP shape)", () => {
    const json = '{"version":3}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    expect(decodeDataUri(`data:application/json;base64,${b64}`)).toBe(json);
  });

  it("decodes base64 with extra parameters (webpack inline-source-map shape)", () => {
    // Regression for the regex bug — `;charset=utf-8;base64,` previously
    // failed to match because `[^,;]*` refused to consume `;`, and `;base64`
    // had to be the *only* parameter.
    const json = '{"version":3,"sources":["src/foo.ts"]}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    expect(decodeDataUri(`data:application/json;charset=utf-8;base64,${b64}`)).toBe(json);
  });

  it("decodes parameter order variants", () => {
    const json = '{"x":1}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    // `base64` parameter not necessarily last among params
    expect(decodeDataUri(`data:application/json;base64;charset=utf-8,${b64}`)).toBe(json);
  });

  it("decodes URL-encoded (non-base64) payloads", () => {
    expect(decodeDataUri("data:text/plain,hello%20world")).toBe("hello world");
  });

  it("throws on non-data URIs and malformed inputs", () => {
    expect(() => decodeDataUri("http://example.com")).toThrow(/Not a data URI/);
    expect(() => decodeDataUri("data:no-comma-here")).toThrow(/no comma/);
    expect(() => decodeDataUri("data:application/json;base64,")).toThrow(/Empty/);
  });
});
