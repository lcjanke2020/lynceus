import { describe, it, expect } from "vitest";
import {
  LocatorError,
  locatorBySchema,
  locatorSchema,
  normalizeLocator,
  parseLocator,
  serializeLocator,
  type LocatorBy,
} from "../src/locator.js";
import * as contract from "../src/contract.js";

describe("locator contract — normalizeLocator", () => {
  it("infers by=css from selector or css", () => {
    expect(normalizeLocator({ selector: "#go" })).toMatchObject({ by: "css", selector: "#go" });
    expect(normalizeLocator({ css: ".btn" })).toMatchObject({ by: "css", selector: ".btn" });
  });

  it("folds the name fallback into the strategy-specific field", () => {
    expect(normalizeLocator({ by: "text", name: "Submit" })).toMatchObject({ by: "text", text: "Submit" });
    expect(normalizeLocator({ by: "label", name: "Email" })).toMatchObject({ by: "label", label: "Email" });
    expect(normalizeLocator({ by: "test_id", name: "row-1" })).toMatchObject({ by: "test_id", test_id: "row-1" });
    expect(normalizeLocator({ by: "placeholder", name: "Search" })).toMatchObject({
      by: "placeholder",
      placeholder: "Search",
    });
  });

  it("throws LocatorError(missing_arg) for under-specified specs", () => {
    expect(() => normalizeLocator({})).toThrowError(LocatorError);
    try {
      normalizeLocator({ by: "role" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LocatorError);
      expect((e as LocatorError).code).toBe("missing_arg");
    }
  });

  it("throws LocatorError(invalid_locator) for an unsupported strategy", () => {
    try {
      normalizeLocator({ by: "xpath" as unknown as LocatorBy });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LocatorError);
      expect((e as LocatorError).code).toBe("invalid_locator");
    }
  });
});

describe("locator contract — schema + helpers", () => {
  it("locatorBySchema enumerates the supported strategies", () => {
    expect(locatorBySchema.options).toContain("role");
    expect(locatorBySchema.options).toContain("css");
    expect(() => locatorBySchema.parse("xpath")).toThrow();
  });

  it("locatorSchema parses a valid spec and rejects wrong field types", () => {
    expect(locatorSchema.parse({ by: "role", role: "button", name: "Go" })).toMatchObject({ role: "button" });
    expect(locatorSchema.safeParse({ exact: "yes" }).success).toBe(false);
  });

  it("parseLocator validates then normalizes unknown input", () => {
    expect(parseLocator({ selector: "#go" })).toMatchObject({ by: "css", selector: "#go" });
    expect(() => parseLocator({ role: 123 })).toThrow();
    expect(() => parseLocator({ by: "name" })).toThrowError(LocatorError);
  });

  it("serializeLocator returns a normalized JSON string", () => {
    expect(JSON.parse(serializeLocator({ css: ".x" }))).toMatchObject({ by: "css", selector: ".x" });
  });

  it("serializeLocator is stable across equivalent aliases", () => {
    // `{ css }` and `{ selector }` mean the same thing — they must serialize identically.
    expect(serializeLocator({ css: ".x" })).toBe(serializeLocator({ selector: ".x" }));
    expect(serializeLocator({ css: ".x" })).toBe('{"by":"css","selector":".x"}');
    // Alias keys are dropped from the canonical output (no leftover `"css":` / `"testId":`).
    expect(serializeLocator({ css: ".x" })).not.toContain('"css":');
    expect(serializeLocator({ by: "test_id", testId: "row" })).toBe('{"by":"test_id","test_id":"row"}');
    // Key order is fixed regardless of input key order.
    expect(serializeLocator({ selector: ".x", by: "css" })).toBe(serializeLocator({ by: "css", css: ".x" }));
  });
});

describe("public barrel — src/contract.ts", () => {
  it("re-exports the canonical contract symbols", () => {
    expect(contract.locatorSchema).toBe(locatorSchema);
    expect(contract.normalizeLocator).toBe(normalizeLocator);
    expect(contract.parseLocator).toBe(parseLocator);
    expect(contract.serializeLocator).toBe(serializeLocator);
    expect(contract.LocatorError).toBe(LocatorError);
  });
});
