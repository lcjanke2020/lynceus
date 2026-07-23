import { describe, expect, it } from "vitest";
import { ToolError } from "../util/errors.js";
import { resolveFrameworkAdapter } from "./adapter.js";
import { reactFrameworkAdapter } from "./react.js";

describe("resolveFrameworkAdapter", () => {
  it("resolves react to the React adapter", () => {
    expect(resolveFrameworkAdapter("react")).toBe(reactFrameworkAdapter);
    expect(resolveFrameworkAdapter(" React ")).toBe(reactFrameworkAdapter);
  });

  it("rejects unknown frameworks with the structured tool error", () => {
    try {
      resolveFrameworkAdapter("vue");
      throw new Error("expected resolveFrameworkAdapter to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect(error).toMatchObject({ code: "unsupported_framework" });
      expect((error as Error).message).toContain('"vue"');
      expect((error as Error).message).toContain("react");
    }
  });
});
