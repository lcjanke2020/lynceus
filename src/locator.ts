/**
 * Canonical `LocatorSpec` contract for lynceus.
 *
 * This module is the single source of truth for the structured element-locator
 * shape that `locate`, `wait_for`, and the form-driving tools accept. It is
 * deliberately **side-effect free** and depends only on `zod`, so external
 * consumers can import it (via `lynceus/contract`) to produce and validate specs
 * without pulling in the CLI/server. Tool code re-imports these symbols rather
 * than redefining them, so the published contract can never silently drift from
 * what the tools actually accept.
 */
import { z } from "zod";

/**
 * Error thrown by {@link normalizeLocator} / {@link parseLocator} for an invalid
 * spec. `code` mirrors the lynceus tool error codes so tool handlers can re-wrap it
 * structurally: `"missing_arg"` when a spec is under-specified for its strategy,
 * `"invalid_locator"` for an unsupported strategy.
 */
export class LocatorError extends Error {
  readonly code: string;
  constructor(message: string, code = "missing_arg") {
    super(message);
    this.name = "LocatorError";
    this.code = code;
  }
}

/** The locator strategies lynceus understands. `css` is the default when a selector is given. */
export const locatorBySchema = z.enum([
  "css",
  "text",
  "role",
  "test_id",
  "testId",
  "label",
  "placeholder",
  "name",
]);

/**
 * The raw Zod shape for a LocatorSpec. Spread into tool input schemas
 * (`{ ...locatorShape, ... }`) so the field docs stay identical everywhere.
 */
export const locatorShape = {
  by: locatorBySchema.optional().describe("Locator strategy. Omit when passing selector/css for a CSS lookup."),
  selector: z.string().optional().describe("CSS selector. Equivalent to by=css."),
  css: z.string().optional().describe("CSS selector. Equivalent to selector."),
  text: z.string().optional().describe("Text to match for by=text."),
  role: z.string().optional().describe("ARIA/implicit role for by=role, e.g. button, link, textbox."),
  name: z.string().optional().describe("Accessible name, field name, or fallback value depending on the locator strategy."),
  test_id: z.string().optional().describe("Value for data-testid, data-test-id, or data-test."),
  // Both snake_case (`test_id`) and camelCase (`testId`) are accepted so callers
  // can use whichever matches their convention; `normalizeLocator` /
  // `serializeLocator` fold them to the canonical `test_id`. Likewise `name` is a
  // cross-strategy fallback that gets folded into the strategy-specific field.
  testId: z.string().optional().describe("CamelCase alias for test_id."),
  label: z.string().optional().describe("Label text for by=label."),
  placeholder: z.string().optional().describe("Placeholder text for by=placeholder."),
  exact: z.boolean().optional().describe("Default false: substring match for text/name-like fields."),
};

/** A standalone `ZodObject` for a LocatorSpec — external consumers can `.parse()`/`.safeParse()`. */
export const locatorSchema = z.object(locatorShape);

export type LocatorBy = z.infer<typeof locatorBySchema>;

export interface LocatorSpec {
  by?: LocatorBy;
  selector?: string;
  css?: string;
  text?: string;
  role?: string;
  name?: string;
  test_id?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  exact?: boolean;
}

/**
 * Validate and canonicalize a spec: infer `by` from selector/css, enforce the
 * required field for the chosen strategy, and fold the `name` fallback into the
 * strategy-specific field. Throws {@link LocatorError} on an under-specified spec.
 */
export function normalizeLocator(input: LocatorSpec): LocatorSpec {
  const by = input.by ?? (input.selector || input.css ? "css" : undefined);
  if (!by) throw new LocatorError("by is required unless selector/css is supplied");
  switch (by) {
    case "css": {
      const selector = input.selector ?? input.css;
      if (!selector) throw new LocatorError("selector or css is required for by=css");
      return { ...input, by, selector };
    }
    case "role":
      if (!input.role) throw new LocatorError("role is required for by=role");
      return { ...input, by };
    case "text":
      if (!input.text && !input.name) throw new LocatorError("text or name is required for by=text");
      return { ...input, by, text: input.text ?? input.name };
    case "test_id":
    case "testId": {
      const testId = input.test_id ?? input.testId ?? input.name;
      if (!testId) throw new LocatorError(`test_id, testId, or name is required for by=${by}`);
      return { ...input, by, test_id: testId };
    }
    case "label": {
      const label = input.label ?? input.name;
      if (!label) throw new LocatorError("label or name is required for by=label");
      return { ...input, by, label };
    }
    case "placeholder": {
      const placeholder = input.placeholder ?? input.name;
      if (!placeholder) throw new LocatorError("placeholder or name is required for by=placeholder");
      return { ...input, by, placeholder };
    }
    case "name":
      if (!input.name) throw new LocatorError("name is required for by=name");
      return { ...input, by };
    default: {
      // Compile-time exhaustiveness: if `locatorBySchema` gains a strategy and a
      // case here is missed, `by` is no longer `never` and this fails to build
      // (pairs with `noFallthroughCasesInSwitch`).
      const _exhaustive: never = by;
      throw new LocatorError(`unsupported locator strategy: ${String(_exhaustive)}`, "invalid_locator");
    }
  }
}

/** Validate an unknown value as a LocatorSpec (shape + strategy requirements). */
export function parseLocator(input: unknown): LocatorSpec {
  return normalizeLocator(locatorSchema.parse(input));
}

/**
 * Serialize a LocatorSpec to a stable, normalized JSON string. Equivalent specs
 * serialize identically regardless of which alias the caller used — e.g.
 * `{ css: ".x" }` and `{ selector: ".x" }` both yield `{"by":"css","selector":".x"}`
 * — so the output is safe to use as a cache key or for equality checks.
 */
export function serializeLocator(spec: LocatorSpec): string {
  return JSON.stringify(canonicalLocator(spec));
}

/**
 * Reduce a spec to only its canonical fields, in a fixed key order, dropping
 * alias inputs (`css`, `testId`, and the cross-strategy `name` fallback). This is
 * what makes {@link serializeLocator} stable across equivalent inputs — the raw
 * `normalizeLocator` result still carries whichever aliases the caller passed.
 */
function canonicalLocator(spec: LocatorSpec): LocatorSpec {
  const n = normalizeLocator(spec);
  const out: LocatorSpec = {};
  switch (n.by) {
    case "css":
      out.by = "css";
      out.selector = n.selector;
      break;
    case "role":
      out.by = "role";
      out.role = n.role;
      if (n.name !== undefined) out.name = n.name;
      break;
    case "text":
      out.by = "text";
      out.text = n.text;
      break;
    case "test_id":
    case "testId":
      out.by = "test_id";
      out.test_id = n.test_id;
      break;
    case "label":
      out.by = "label";
      out.label = n.label;
      break;
    case "placeholder":
      out.by = "placeholder";
      out.placeholder = n.placeholder;
      break;
    case "name":
      out.by = "name";
      out.name = n.name;
      break;
  }
  if (n.exact !== undefined) out.exact = n.exact;
  return out;
}
