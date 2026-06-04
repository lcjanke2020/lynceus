import { describe, it, expect } from "vitest";
import type { Protocol } from "devtools-protocol";
import { truncate, previewRemoteObject, describeRemote, toolText, toolJson } from "./format.js";

describe("truncate", () => {
  it("returns the string unchanged when ≤ max", () => {
    expect(truncate("hello", 10)).toBe("hello");
    // Default max is 200; anything shorter than that should pass through.
    expect(truncate("x".repeat(199))).toBe("x".repeat(199));
  });

  it("appends a counter when the string exceeds max", () => {
    const out = truncate("abcdef", 3);
    expect(out).toBe("abc…(+3 chars)");
  });

  it("preserves an exact-boundary string (length === max)", () => {
    // Critical edge case: equality should NOT be treated as overflow.
    // A regression to `if (s.length < max)` would silently chop the last char.
    const s = "x".repeat(50);
    expect(truncate(s, 50)).toBe(s);
  });
});

describe("previewRemoteObject", () => {
  it("returns unserializableValue verbatim for NaN/Infinity/-0", () => {
    // CDP encodes these as strings because JSON can't carry them.
    expect(previewRemoteObject({ type: "number", unserializableValue: "NaN" } as Protocol.Runtime.RemoteObject)).toBe(
      "NaN",
    );
    expect(
      previewRemoteObject({ type: "number", unserializableValue: "Infinity" } as Protocol.Runtime.RemoteObject),
    ).toBe("Infinity");
    expect(
      previewRemoteObject({ type: "number", unserializableValue: "-0" } as Protocol.Runtime.RemoteObject),
    ).toBe("-0");
  });

  it("handles undefined and subtype null distinctly", () => {
    expect(previewRemoteObject({ type: "undefined" } as Protocol.Runtime.RemoteObject)).toBe("undefined");
    expect(previewRemoteObject({ type: "object", subtype: "null" } as Protocol.Runtime.RemoteObject)).toBe("null");
  });

  it("JSON-stringifies strings (preserving quotes + embedded specials)", () => {
    // Regression guard: if this ever switched to raw `obj.value`, console
    // buffering would lose the ability to distinguish "" from undefined,
    // and embedded newlines would corrupt downstream line-oriented output.
    expect(previewRemoteObject({ type: "string", value: "hi" } as Protocol.Runtime.RemoteObject)).toBe('"hi"');
    expect(previewRemoteObject({ type: "string", value: 'a"b' } as Protocol.Runtime.RemoteObject)).toBe('"a\\"b"');
    expect(previewRemoteObject({ type: "string", value: "x\ny" } as Protocol.Runtime.RemoteObject)).toBe('"x\\ny"');
    expect(previewRemoteObject({ type: "string", value: "" } as Protocol.Runtime.RemoteObject)).toBe('""');
    // value omitted → coerced to ""
    expect(previewRemoteObject({ type: "string" } as Protocol.Runtime.RemoteObject)).toBe('""');
  });

  it("stringifies numbers, booleans, and bigints", () => {
    expect(previewRemoteObject({ type: "number", value: 42 } as Protocol.Runtime.RemoteObject)).toBe("42");
    expect(previewRemoteObject({ type: "boolean", value: true } as Protocol.Runtime.RemoteObject)).toBe("true");
    expect(previewRemoteObject({ type: "bigint", value: "9007199254740993" } as Protocol.Runtime.RemoteObject)).toBe(
      "9007199254740993",
    );
  });

  it("trims multi-line function descriptions to the preview cap", () => {
    const body = "function fn() {\n" + "  // ".repeat(80) + "\n}";
    const out = previewRemoteObject({ type: "function", description: body } as Protocol.Runtime.RemoteObject);
    expect(out.startsWith("function fn()")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(220); // 200 cap + counter overhead
  });

  it("falls back to 'function' when description is missing", () => {
    expect(previewRemoteObject({ type: "function" } as Protocol.Runtime.RemoteObject)).toBe("function");
  });

  it("renders array previews with overflow ellipsis", () => {
    const obj: Protocol.Runtime.RemoteObject = {
      type: "object",
      subtype: "array",
      preview: {
        type: "object",
        subtype: "array",
        description: "Array(50)",
        overflow: true,
        properties: [
          { name: "0", type: "number", value: "1" },
          { name: "1", type: "string", value: "two" },
          { name: "2", type: "boolean", value: "true" },
        ],
      },
    };
    expect(previewRemoteObject(obj)).toBe('[1, "two", true, …]');
  });

  it("renders object previews keyed by name and elides 'Object' wrappers", () => {
    const obj: Protocol.Runtime.RemoteObject = {
      type: "object",
      preview: {
        type: "object",
        description: "Object",
        overflow: false,
        properties: [
          { name: "a", type: "number", value: "1" },
          { name: "b", type: "string", value: "hi" },
        ],
      },
    };
    // "Object" description should be elided per format.ts:39.
    expect(previewRemoteObject(obj)).toBe('{a: 1, b: "hi"}');
  });

  it("keeps class names that aren't the generic 'Object'", () => {
    const obj: Protocol.Runtime.RemoteObject = {
      type: "object",
      preview: {
        type: "object",
        description: "MyClass",
        overflow: false,
        properties: [{ name: "x", type: "number", value: "1" }],
      },
    };
    expect(previewRemoteObject(obj)).toBe("MyClass {x: 1}");
  });

  it("falls back to description when no preview is present", () => {
    expect(
      previewRemoteObject({ type: "object", description: "MyError: boom" } as Protocol.Runtime.RemoteObject),
    ).toBe("MyError: boom");
  });

  it("falls back to className/subtype/type for opaque objects", () => {
    expect(previewRemoteObject({ type: "object", className: "Map" } as Protocol.Runtime.RemoteObject)).toBe("Map");
    expect(previewRemoteObject({ type: "object", subtype: "promise" } as Protocol.Runtime.RemoteObject)).toBe(
      "promise",
    );
    expect(previewRemoteObject({ type: "object" } as Protocol.Runtime.RemoteObject)).toBe("object");
  });

  it("truncates over-long descriptions in the description fallback", () => {
    const big = "x".repeat(500);
    const out = previewRemoteObject({ type: "object", description: big } as Protocol.Runtime.RemoteObject);
    expect(out).toContain("…(+300 chars)");
  });
});

describe("describeRemote", () => {
  it("returns type from subtype-or-type, the preview text, and an objectId when present", () => {
    const obj: Protocol.Runtime.RemoteObject = {
      type: "object",
      subtype: "array",
      objectId: "obj-1",
      description: "Array(0)",
    };
    expect(describeRemote(obj)).toEqual({ type: "array", preview: "Array(0)", objectId: "obj-1" });
  });

  it("omits objectId when absent", () => {
    expect(describeRemote({ type: "number", value: 7 } as Protocol.Runtime.RemoteObject)).toEqual({
      type: "number",
      preview: "7",
    });
  });
});

describe("toolText / toolJson envelopes", () => {
  it("toolText wraps a string in the MCP content shape", () => {
    expect(toolText("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("toolJson pretty-prints with two-space indent", () => {
    const r = toolJson({ a: 1 });
    expect(r.content[0]?.text).toBe('{\n  "a": 1\n}');
  });
});
