import { describe, it, expect } from "vitest";
import { buildConditionExpression } from "./breakpoints.js";

// `buildConditionExpression` builds the expression CDP evaluates inside the
// page on every potential breakpoint hit. Getting the encoding wrong has
// two failure modes:
//  - silent: a logpoint that never logs because the regex doesn't apply
//  - loud:   a syntax error that turns the breakpoint into a permanent
//            no-op once Chrome rejects the condition
// Both regress slowly because the breakpoint just doesn't fire — there's
// no good signal until someone notices their logs are missing.

describe("buildConditionExpression", () => {
  it("returns undefined when neither condition nor logMessage is supplied", () => {
    expect(buildConditionExpression()).toBeUndefined();
    expect(buildConditionExpression(undefined, undefined)).toBeUndefined();
    expect(buildConditionExpression("", "")).toBeUndefined();
  });

  it("passes a bare condition through unchanged", () => {
    expect(buildConditionExpression("count > 5")).toBe("count > 5");
    expect(buildConditionExpression("user.id === 'abc'")).toBe("user.id === 'abc'");
  });

  it("encodes a bare logMessage as a never-pause logpoint", () => {
    const out = buildConditionExpression(undefined, "hit foo");
    // Must short-circuit with `, false` so the breakpoint never actually pauses.
    expect(out).toContain(", false)");
    // Must JSON-stringify the template literal to survive embedded quotes/newlines.
    expect(out).toContain(JSON.stringify("hit foo"));
    // Must include the `replace` shape so {expr} interpolation works.
    expect(out).toContain(".replace(/");
  });

  it("combines condition + logMessage so logging only fires when condition is truthy", () => {
    const out = buildConditionExpression("x > 0", "x is positive");
    // Shape: `(condition) && (log, false)` — short-circuits both ways.
    expect(out).toMatch(/^\(x > 0\) && \(/);
    expect(out).toContain(", false)");
  });

  it("survives logMessage with embedded double quotes", () => {
    // The template literal contains characters that would corrupt naive
    // string concatenation. JSON.stringify is the only safe encoding.
    const message = 'value is "alpha"';
    const out = buildConditionExpression(undefined, message);
    // The original message should appear inside the JSON.stringified form.
    expect(out).toContain(JSON.stringify(message));
    // The literal `"` chars from the message should be present *escaped*
    // (they live inside a string literal that's emitted into JS).
    expect(out).toContain('\\"alpha\\"');
  });

  it("survives logMessage with embedded newlines", () => {
    const message = "line1\nline2";
    const out = buildConditionExpression(undefined, message);
    // JSON.stringify converts \n to the two-char escape \\n.
    expect(out).toContain(JSON.stringify(message));
    expect(out).toContain("\\n");
  });

  it("preserves the {expr} interpolation regex over JSON-encoding", () => {
    // The regex /\{([^}]+)\}/g is what makes log messages like "x={x}"
    // substitute the live value of x. If JSON.stringify ever swallowed
    // the literal `{`/`}` brackets, interpolation would silently break.
    const message = "hit count={count}";
    const out = buildConditionExpression(undefined, message);
    expect(out).toContain("{count}");
    // The regex itself should still be in the emitted expression.
    expect(out).toContain("([^}]+)");
  });

  it("logMessage referencing a value: emitted expression evaluates to false", () => {
    // Sanity check: actually evaluate the expression in this Node process
    // with a `count` binding in scope and confirm it returns false (so the
    // breakpoint would NOT pause). This proves the short-circuit works
    // end-to-end, not just structurally.
    const expr = buildConditionExpression(undefined, "count={count}")!;
    // Eval inside an IIFE so we can shadow console.log without polluting
    // the test runner's console.
    let logged: string[] = [];
    const sandbox = (count: number) => {
      const console = { log: (s: string) => logged.push(s) };
      return new Function("count", "console", `return ${expr};`)(count, console);
    };
    expect(sandbox(7)).toBe(false);
    expect(logged).toEqual(["count=7"]);
  });

  it("condition + logMessage: only logs when condition is truthy", () => {
    const expr = buildConditionExpression("count > 5", "count={count}")!;
    let logged: string[] = [];
    const sandbox = (count: number) => {
      const console = { log: (s: string) => logged.push(s) };
      return new Function("count", "console", `return ${expr};`)(count, console);
    };
    // count=3 → condition false → no log, returns falsy
    expect(sandbox(3)).toBe(false);
    expect(logged).toEqual([]);
    // count=7 → condition true → logs and still returns false
    expect(sandbox(7)).toBe(false);
    expect(logged).toEqual(["count=7"]);
  });

  it("interpolation falls back to {expr=?} on evaluation error", () => {
    // The catch block in the emitted regex replacer guards against ReferenceErrors.
    const expr = buildConditionExpression(undefined, "v={undefinedVar}")!;
    let logged: string[] = [];
    const console = { log: (s: string) => logged.push(s) };
    new Function("console", `return ${expr};`)(console);
    expect(logged).toEqual(["v={undefinedVar=?}"]);
  });
});
