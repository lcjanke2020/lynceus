/**
 * Canonical `LocatorSpec` contract for cdp-mcp.
 *
 * This module is the single source of truth for the structured element-locator
 * shape that `locate`, `wait_for`, and the form-driving tools accept. It is
 * deliberately **side-effect free** and depends only on `zod`, so external
 * consumers can import it (via `cdp-mcp/contract`) to produce and validate specs
 * without pulling in the CLI/server. Tool code re-imports these symbols rather
 * than redefining them, so the published contract can never silently drift from
 * what the tools actually accept.
 */
import { z } from "zod";

/**
 * Error thrown by {@link normalizeLocator} / {@link parseLocator} when a spec is
 * under-specified for its strategy. `code` mirrors the cdp-mcp tool error codes
 * (always `"missing_arg"` today) so tool handlers can re-wrap it structurally.
 */
export class LocatorError extends Error {
  readonly code: string;
  constructor(message: string, code = "missing_arg") {
    super(message);
    this.name = "LocatorError";
    this.code = code;
  }
}

/** The locator strategies cdp-mcp understands. `css` is the default when a selector is given. */
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
  }
}

/** Validate an unknown value as a LocatorSpec (shape + strategy requirements). */
export function parseLocator(input: unknown): LocatorSpec {
  return normalizeLocator(locatorSchema.parse(input));
}

/** Serialize a LocatorSpec to a stable, normalized JSON string. */
export function serializeLocator(spec: LocatorSpec): string {
  return JSON.stringify(normalizeLocator(spec));
}
