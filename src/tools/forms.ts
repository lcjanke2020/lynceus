import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireSession } from "../session/state.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";
import { locatorShape, type LocatorSpec } from "../locator.js";
import {
  normalizeLocator,
  locatorHelpersScript,
  mutationHelpersScript,
} from "./_locator_runtime.js";

/**
 * Form-driving tools (issue #12 items 1, 2, 3, 6). Each LocatorSpec-driven tool
 * resolves its target through the shared in-page locator runtime (the same
 * `findElements`/visibility semantics as `locate`), mutates it, and dispatches
 * `input`/`change` so app frameworks observe the change.
 */
export function registerFormTools(server: McpServer) {
  registerJsonTool(
    server,
    "select_option",
    "Set the value of a native <select> located by LocatorSpec. Match options by option_value, option_label, and/or option_index (named distinctly from the locator's own fields). Dispatches input + change. For <select multiple>, pass multiple:true to select every match. Returns status:\"selected\" with the resolved option(s).",
    {
      ...locatorShape,
      option_value: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Option value attribute(s) to select."),
      option_label: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Visible option label/text to select."),
      option_index: z
        .union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative())])
        .optional()
        .describe("Zero-based option index(es) to select."),
      multiple: z.boolean().optional().describe("Select every match in a <select multiple> (default false: first match only)."),
      session_id: z.string().optional().describe("Target a worker/iframe session; omit for the root page."),
    },
    async (input: SelectOptionInput) => {
      const values = toArray(input.option_value);
      const labels = toArray(input.option_label);
      const indexes = toArray(input.option_index);
      if (values.length === 0 && labels.length === 0 && indexes.length === 0) {
        throw new ToolError("missing_arg", "select_option requires one of option_value, option_label, or option_index");
      }
      const locator = normalizeLocator(input);
      const body = String.raw`
        if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "element is not a <select>", code: "wrong_element" };
        const wantValues = ${JSON.stringify(values)};
        const wantLabels = ${JSON.stringify(labels)};
        const wantIndexes = ${JSON.stringify(indexes)};
        const allowMultiple = ${JSON.stringify(!!input.multiple)} && el.multiple;
        const optionLabel = (opt) => (opt.label || opt.textContent || "").trim();
        const isMatch = (opt, i) => wantValues.includes(opt.value) || wantLabels.includes(optionLabel(opt)) || wantIndexes.includes(i);
        const options = Array.from(el.options);
        const selected = [];
        if (allowMultiple) {
          // Decide matches before mutating: a zero-match select_option must
          // leave the existing selection untouched (and fall through to the
          // not_found return below) rather than deselect every option and
          // report an error without firing events. On a real match the
          // non-matches are cleared, giving multi-select replace semantics.
          const matched = options.map((opt, i) => isMatch(opt, i));
          if (matched.some(Boolean)) {
            options.forEach((opt, i) => {
              opt.selected = matched[i];
              if (matched[i]) selected.push({ value: opt.value, label: optionLabel(opt), index: i });
            });
          }
        } else {
          for (let i = 0; i < options.length; i++) {
            if (isMatch(options[i], i)) {
              el.value = options[i].value;
              selected.push({ value: options[i].value, label: optionLabel(options[i]), index: i });
              break;
            }
          }
        }
        if (selected.length === 0) return { ok: false, error: "no <option> matched the requested value/label/index", code: "not_found" };
        fireEvents(el, ["input", "change"]);
        return { ok: true, selected, multiple: el.multiple, count };
      `;
      const v = await runMutation(locator, body, input.session_id);
      if (!v.ok) throw new ToolError(v.code ?? "not_found", v.error ?? "select_option failed");
      return { status: "selected", selected: v.selected, multiple: v.multiple, count: v.count };
    },
  );

  registerToggle(server, "check");
  registerToggle(server, "uncheck");

  registerJsonTool(
    server,
    "fill",
    "Set an input, textarea, or contenteditable element (located by LocatorSpec) to exactly the given value, replacing any existing contents. Dispatches input + change. Use this (not type_text) when you need the field to end up equal to a specific value.",
    {
      ...locatorShape,
      value: z.string().describe("The exact value the field should contain afterwards (replaces existing contents)."),
      session_id: z.string().optional().describe("Target a worker/iframe session; omit for the root page."),
    },
    async (input: LocatorSpec & { value: string; session_id?: string }) => {
      const locator = normalizeLocator(input);
      const body = String.raw`
        // fill writes free text, so restrict to text-like controls. Many other
        // elements expose a "value" property whose meaning is not "the text the
        // user sees" — <select> (the selected option), checkbox/radio (the
        // submitted value, not the checked state), and button/submit/reset/file/
        // image/range/color inputs — so editing them via fill would be surprising.
        // Those get a structured wrong_element; use select_option / check / uncheck.
        const NON_TEXT_INPUT_TYPES = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color"];
        const isTextInput = el instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.includes((el.getAttribute("type") || "text").toLowerCase());
        const fillable = el.isContentEditable || el instanceof HTMLTextAreaElement || isTextInput;
        if (!fillable) {
          const tag = el.tagName.toLowerCase();
          const detail = el instanceof HTMLInputElement ? "<input type=" + (el.getAttribute("type") || "text") + ">" : "<" + tag + ">";
          return { ok: false, error: "element is not fillable — fill targets a text <input>, <textarea>, or contenteditable, got " + detail, code: "wrong_element" };
        }
        const value = ${JSON.stringify(input.value)};
        el.focus();
        if (!("value" in el) && el.isContentEditable) { el.textContent = value; }
        else { el.value = value; }
        fireEvents(el, ["input", "change"]);
        return { ok: true, tag: el.tagName.toLowerCase(), count };
      `;
      const v = await runMutation(locator, body, input.session_id);
      if (!v.ok) throw new ToolError(v.code ?? "not_found", v.error ?? "fill failed");
      return { status: "filled", value_length: input.value.length, tag: v.tag, count: v.count };
    },
  );

  registerJsonTool(
    server,
    "suggest_locator",
    "Given a starting element (by node_id or CSS selector), return ranked LocatorSpec candidates (role+name → text → test-id → label → placeholder → name → CSS fallback), each annotated with how many elements it currently matches (1 = unambiguous) and whether it resolves back to the target. Useful for validating/normalising a locator before driving with it.",
    {
      node_id: z.number().int().positive().optional().describe("DOM nodeId from query_selector/locate."),
      selector: z.string().optional().describe("CSS selector for the starting element (alternative to node_id)."),
      session_id: z.string().optional().describe("Target a worker/iframe session; omit for the root page."),
    },
    async (input: { node_id?: number; selector?: string; session_id?: string }) => {
      const s = requireSession();
      if (input.node_id === undefined && !input.selector) {
        throw new ToolError("missing_arg", "node_id or selector required");
      }
      let value: SuggestResult | undefined;
      if (input.selector && input.node_id === undefined) {
        const expression = `(() => {
          ${locatorHelpersScript()}${suggestDefScript()}
          let el;
          try {
            el = document.querySelector(${JSON.stringify(input.selector)});
          } catch (e) {
            return { ok: false, error: "Invalid CSS selector " + ${JSON.stringify(input.selector)} + ": " + e.message, code: "invalid_selector" };
          }
          if (!el) return { ok: false, error: "no element matches selector", code: "not_found" };
          return suggest(el);
        })()`;
        const res = await s.client!.send("Runtime.evaluate", { expression, returnByValue: true }, input.session_id);
        value = res.result.value as SuggestResult;
      } else {
        const resolved = await s.client!.send("DOM.resolveNode", { nodeId: input.node_id }, input.session_id);
        const objectId = resolved.object?.objectId;
        if (!objectId) throw new ToolError("not_found", `could not resolve node ${input.node_id}`);
        const functionDeclaration = `function() {
          ${locatorHelpersScript()}${suggestDefScript()}
          return suggest(this);
        }`;
        const res = await s.client!.send(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration, returnByValue: true },
          input.session_id,
        );
        value = res.result.value as SuggestResult;
      }
      if (!value || !value.ok) throw new ToolError(value?.code ?? "not_found", value?.error ?? "suggest_locator failed");
      return { candidates: value.candidates, recommended: value.recommended };
    },
  );
}

interface SelectOptionInput extends LocatorSpec {
  option_value?: string | string[];
  option_label?: string | string[];
  option_index?: number | number[];
  multiple?: boolean;
  session_id?: string;
}

interface MutationResult {
  ok: boolean;
  error?: string;
  code?: string;
  [k: string]: unknown;
}

interface SuggestResult {
  ok: boolean;
  error?: string;
  code?: string;
  candidates?: unknown[];
  recommended?: number | null;
}

function toArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Resolve `locator` to a single element in the page and run `body` against it.
 * `body` is JS that runs with `el` (the resolved element), `count` (total
 * matches), and `fireEvents(el, types)` in scope, and must `return` a
 * `{ ok, ... }` object (with an optional `code` on failure).
 */
async function runMutation(locator: LocatorSpec, body: string, sessionId?: string): Promise<MutationResult> {
  const s = requireSession();
  const expression = `(() => {
    const spec = ${JSON.stringify(locator)};
    ${locatorHelpersScript()}${mutationHelpersScript()}
    const resolved = resolveOne(spec);
    if (!resolved.ok) return { ok: false, error: resolved.error, code: resolved.code ?? "not_found" };
    const el = resolved.el;
    const count = resolved.count;
    ${body}
  })()`;
  const res = await s.client!.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return res.result.value as MutationResult;
}

function registerToggle(server: McpServer, name: "check" | "uncheck") {
  const wantChecked = name === "check";
  const description =
    name === "check"
      ? "Ensure a checkbox or radio (located by LocatorSpec) is checked. Idempotent: returns status:\"already-checked\" with no events if it already is, else sets it and dispatches input + change."
      : "Ensure a checkbox or radio (located by LocatorSpec) is unchecked. Idempotent: returns status:\"already-unchecked\" with no events if it already is, else clears it and dispatches input + change.";
  registerJsonTool(
    server,
    name,
    description,
    { ...locatorShape, session_id: z.string().optional().describe("Target a worker/iframe session; omit for the root page.") },
    async (input: LocatorSpec & { session_id?: string }) => {
      const locator = normalizeLocator(input);
      const body = String.raw`
        if (!(el instanceof HTMLInputElement) || (el.type !== "checkbox" && el.type !== "radio"))
          return { ok: false, error: "element is not a checkbox or radio", code: "wrong_element" };
        if (el.checked === ${JSON.stringify(wantChecked)}) return { ok: true, changed: false, checked: el.checked, count };
        el.checked = ${JSON.stringify(wantChecked)};
        fireEvents(el, ["input", "change"]);
        return { ok: true, changed: true, checked: el.checked, count };
      `;
      const v = await runMutation(locator, body, input.session_id);
      if (!v.ok) throw new ToolError(v.code ?? "not_found", v.error ?? `${name} failed`);
      const status = wantChecked
        ? v.changed
          ? "checked"
          : "already-checked"
        : v.changed
          ? "unchecked"
          : "already-unchecked";
      return { status, checked: v.checked, count: v.count };
    },
  );
}

/**
 * In-page `suggest(el)` definition. Compose after `locatorHelpersScript()` (it
 * relies on `implicitRole`/`accessibleName`/`labelText`/`textOf`/`cssPath`/
 * `findElements`). Builds ranked candidates and re-runs `findElements` per
 * candidate so the reported match counts are exactly what `locate` would produce.
 */
function suggestDefScript(): string {
  return String.raw`
    const suggest = (el) => {
      const role = implicitRole(el);
      const name = accessibleName(el);
      const text = textOf(el);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
      const label = labelText(el);
      const placeholder = el.getAttribute("placeholder");
      const nameAttr = el.getAttribute("name");
      const cands = [];
      if (role && name) cands.push({ by: "role", role, name });
      if (text && text.length <= 80) cands.push({ by: "text", text });
      if (testId) cands.push({ by: "test_id", test_id: testId });
      if (label) cands.push({ by: "label", label });
      if (placeholder) cands.push({ by: "placeholder", placeholder });
      if (nameAttr) cands.push({ by: "name", name: nameAttr });
      cands.push({ by: "css", css: cssPath(el) });
      const annotated = cands.map((locator) => {
        const found = findElements(locator);
        const els = found.ok ? found.elements : [];
        return {
          locator,
          match_count: els.length,
          unambiguous: els.length === 1,
          resolves_to_target: els.indexOf(el) !== -1,
        };
      });
      let recommended = annotated.findIndex((c) => c.unambiguous && c.resolves_to_target);
      if (recommended < 0) recommended = annotated.findIndex((c) => c.resolves_to_target);
      return { ok: true, candidates: annotated, recommended: recommended < 0 ? null : recommended };
    };
  `;
}
