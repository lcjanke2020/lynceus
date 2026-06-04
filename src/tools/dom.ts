import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { requireSession } from "../session/state.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";

const locatorBySchema = z.enum(["css", "text", "role", "test_id", "testId", "label", "placeholder", "name"]);
const locatorShape = {
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
const waitStateSchema = z.enum(["visible", "hidden", "attached", "detached"]);

type LocatorBy = z.infer<typeof locatorBySchema>;
type WaitState = z.infer<typeof waitStateSchema>;

interface LocatorSpec {
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

interface LocateInput extends LocatorSpec {
  include_hidden?: boolean;
  limit?: number;
}

interface WaitForInput extends LocatorSpec {
  state?: WaitState;
  timeout_ms?: number;
  interval_ms?: number;
}

interface FormStateInput {
  names?: string[];
  form_selector?: string;
}

interface LocateResult {
  ok: boolean;
  error?: string;
  found: boolean;
  count: number;
  visible_count: number;
  matches: unknown[];
}

export function registerDomTools(server: McpServer) {
  registerJsonTool(
    server,
    "query_selector",
    "Find an element by CSS selector. Returns nodeId + a short preview.",
    { selector: z.string() },
    async (input: { selector: string }) => {
      const s = requireSession();
      const doc = await s.client!.send("DOM.getDocument", { depth: 1 });
      const found = await s.client!.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: input.selector,
      });
      if (!found.nodeId) return { found: false };
      const desc = await s.client!.send("DOM.describeNode", { nodeId: found.nodeId, depth: 0 });
      return {
        found: true,
        node_id: found.nodeId,
        tag: desc.node.nodeName?.toLowerCase(),
        attrs: pairsToObj(desc.node.attributes ?? []),
        text_preview: (desc.node.nodeValue ?? "").slice(0, 200),
        backend_node_id: desc.node.backendNodeId,
      };
    },
  );

  registerJsonTool(
    server,
    "get_element_html",
    "Get the outer (or inner) HTML for an element.",
    {
      selector: z.string().optional(),
      node_id: z.number().int().positive().optional(),
      outer: z.boolean().optional().describe("Default true"),
    },
    async (input: { selector?: string; node_id?: number; outer?: boolean }) => {
      const s = requireSession();
      let nodeId = input.node_id;
      if (!nodeId) {
        if (!input.selector) throw new ToolError("missing_arg", "selector or node_id required");
        const doc = await s.client!.send("DOM.getDocument", { depth: 1 });
        const found = await s.client!.send("DOM.querySelector", {
          nodeId: doc.root.nodeId,
          selector: input.selector,
        });
        if (!found.nodeId) throw new ToolError("not_found", `No element matches ${input.selector}`);
        nodeId = found.nodeId;
      }
      const outer = input.outer ?? true;
      const html = await s.client!.send("DOM.getOuterHTML", { nodeId });
      if (outer) return { node_id: nodeId, html: html.outerHTML };
      // CDP has no direct innerHTML — derive it.
      const wrapper = html.outerHTML.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
      return { node_id: nodeId, html: wrapper };
    },
  );

  registerJsonTool(
    server,
    "locate",
    "Find elements with a structured LocatorSpec, e.g. { by: 'role', role: 'button', name: 'Submit' }.",
    {
      ...locatorShape,
      include_hidden: z.boolean().optional().describe("Default false: only return visible matches."),
      limit: z.number().int().positive().max(100).optional().describe("Default 20."),
    },
    async (input: LocateInput) => {
      const locator = normalizeLocator(input);
      const result = await evaluateLocator(locator, {
        includeHidden: input.include_hidden ?? false,
        limit: input.limit ?? 20,
      });
      if (!result.ok) throw new ToolError("invalid_locator", result.error ?? "Invalid locator");
      return result;
    },
  );

  registerJsonTool(
    server,
    "wait_for",
    "Poll until a structured LocatorSpec reaches the requested DOM state.",
    {
      ...locatorShape,
      state: waitStateSchema.optional().describe("Default visible."),
      timeout_ms: z.number().int().positive().optional().describe("Default 5000."),
      interval_ms: z.number().int().positive().optional().describe("Default 100."),
    },
    async (input: WaitForInput) => {
      const locator = normalizeLocator(input);
      const state = input.state ?? "visible";
      const timeoutMs = input.timeout_ms ?? 5000;
      const intervalMs = input.interval_ms ?? 100;
      const started = Date.now();
      let lastResult: LocateResult | null = null;

      while (Date.now() - started <= timeoutMs) {
        lastResult = await evaluateLocator(locator, { includeHidden: true, limit: 20 });
        if (!lastResult.ok) throw new ToolError("invalid_locator", lastResult.error ?? "Invalid locator");
        if (matchesWaitState(lastResult, state)) {
          return {
            state,
            elapsed_ms: Date.now() - started,
            locator,
            result: lastResult,
          };
        }
        await delay(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
      }

      throw new ToolError(
        "timeout",
        `Timed out after ${timeoutMs}ms waiting for ${describeLocator(locator)} to be ${state}; last count=${lastResult?.count ?? 0}, visible=${lastResult?.visible_count ?? 0}`,
      );
    },
  );

  registerJsonTool(
    server,
    "get_form_state",
    "Read named form fields using [name=\"...\"] selectors. Omit names to read every named control in the form/page.",
    {
      names: z.array(z.string()).optional(),
      form_selector: z.string().optional().describe("Optional CSS selector for the form or container to inspect."),
    },
    async (input: FormStateInput) => {
      const s = requireSession();
      const res = await s.client!.send("Runtime.evaluate", {
        expression: buildFormStateExpression(input),
        returnByValue: true,
      });
      const value = res.result.value as { ok: boolean; error?: string };
      if (!value.ok) throw new ToolError("invalid_selector", value.error ?? "Unable to read form state");
      return value;
    },
  );

  registerJsonTool(
    server,
    "click",
    "Click an element matched by CSS selector. Uses synthetic input events.",
    { selector: z.string() },
    async (input: { selector: string }) => {
      const s = requireSession();
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(input.selector)});
        if (!el) return { ok: false, error: "no match" };
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`;
      const res = await s.client!.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      });
      const v = res.result.value as { ok: boolean; error?: string; x?: number; y?: number };
      if (!v.ok) throw new ToolError("not_found", `click: ${v.error ?? "unknown"}`);
      const x = v.x!;
      const y = v.y!;
      await s.client!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await s.client!.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await s.client!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return { clicked: input.selector, x, y };
    },
  );

  registerJsonTool(
    server,
    "type_text",
    "Focus a CSS-selected element and type text into it.",
    { selector: z.string(), text: z.string(), clear_first: z.boolean().optional() },
    async (input: { selector: string; text: string; clear_first?: boolean }) => {
      const s = requireSession();
      const focus = await s.client!.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(input.selector)});
          if (!el) return false;
          el.focus();
          ${input.clear_first ? "if ('value' in el) el.value = '';" : ""}
          return true;
        })()`,
        returnByValue: true,
      });
      if (focus.result.value !== true) throw new ToolError("not_found", `type_text: ${input.selector}`);
      await s.client!.send("Input.insertText", { text: input.text });
      return { typed: input.text.length, into: input.selector };
    },
  );

  registerJsonTool(
    server,
    "press_key",
    "Send a key press to the focused element (e.g. Enter, Tab, Escape).",
    { key: z.string() },
    async (input: { key: string }) => {
      const s = requireSession();
      await s.client!.send("Input.dispatchKeyEvent", { type: "keyDown", key: input.key });
      await s.client!.send("Input.dispatchKeyEvent", { type: "keyUp", key: input.key });
      return { pressed: input.key };
    },
  );

  registerJsonTool(
    server,
    "screenshot",
    "Take a screenshot of the current page. Returns base64 PNG by default, or saves to a file.",
    {
      full_page: z.boolean().optional(),
      path: z.string().optional().describe("If set, save to this absolute path and return path instead of base64"),
      format: z.enum(["png", "jpeg"]).optional(),
      quality: z.number().int().min(1).max(100).optional(),
    },
    async (input: { full_page?: boolean; path?: string; format?: "png" | "jpeg"; quality?: number }) => {
      const s = requireSession();
      const r = await s.client!.send("Page.captureScreenshot", {
        format: input.format ?? "png",
        ...(input.quality && input.format === "jpeg" ? { quality: input.quality } : {}),
        captureBeyondViewport: !!input.full_page,
      });
      if (input.path) {
        await writeFile(input.path, Buffer.from(r.data, "base64"));
        return { saved: input.path, bytes: r.data.length };
      }
      return { format: input.format ?? "png", base64: r.data };
    },
  );
}

function pairsToObj(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) {
    out[pairs[i] ?? ""] = pairs[i + 1] ?? "";
  }
  return out;
}

function normalizeLocator(input: LocatorSpec): LocatorSpec {
  const by = input.by ?? (input.selector || input.css ? "css" : undefined);
  if (!by) throw new ToolError("missing_arg", "by is required unless selector/css is supplied");
  switch (by) {
    case "css": {
      const selector = input.selector ?? input.css;
      if (!selector) throw new ToolError("missing_arg", "selector or css is required for by=css");
      return { ...input, by, selector };
    }
    case "role":
      if (!input.role) throw new ToolError("missing_arg", "role is required for by=role");
      return { ...input, by };
    case "text":
      if (!input.text && !input.name) throw new ToolError("missing_arg", "text or name is required for by=text");
      return { ...input, by, text: input.text ?? input.name };
    case "test_id":
    case "testId": {
      const testId = input.test_id ?? input.testId ?? input.name;
      if (!testId) throw new ToolError("missing_arg", `test_id, testId, or name is required for by=${by}`);
      return { ...input, by, test_id: testId };
    }
    case "label": {
      const label = input.label ?? input.name;
      if (!label) throw new ToolError("missing_arg", "label or name is required for by=label");
      return { ...input, by, label };
    }
    case "placeholder": {
      const placeholder = input.placeholder ?? input.name;
      if (!placeholder) throw new ToolError("missing_arg", "placeholder or name is required for by=placeholder");
      return { ...input, by, placeholder };
    }
    case "name":
      if (!input.name) throw new ToolError("missing_arg", "name is required for by=name");
      return { ...input, by };
  }
}

async function evaluateLocator(
  locator: LocatorSpec,
  options: { includeHidden: boolean; limit: number },
): Promise<LocateResult> {
  const s = requireSession();
  const res = await s.client!.send("Runtime.evaluate", {
    expression: buildLocateExpression(locator, options),
    returnByValue: true,
  });
  return res.result.value as LocateResult;
}

function matchesWaitState(result: LocateResult, state: WaitState): boolean {
  switch (state) {
    case "visible":
      return result.visible_count > 0;
    case "attached":
      return result.count > 0;
    case "hidden":
      return result.count === 0 || result.visible_count === 0;
    case "detached":
      return result.count === 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeLocator(locator: LocatorSpec): string {
  return JSON.stringify(locator);
}

function buildLocateExpression(locator: LocatorSpec, options: { includeHidden: boolean; limit: number }): string {
  return `(() => {
    const spec = ${JSON.stringify(locator)};
    const options = ${JSON.stringify(options)};
    ${locatorRuntimeScript()}
    return locate(spec, options);
  })()`;
}

function buildFormStateExpression(input: FormStateInput): string {
  return `(() => {
    const input = ${JSON.stringify(input)};
    ${formStateRuntimeScript()}
    return readFormState(input);
  })()`;
}

function locatorRuntimeScript(): string {
  return String.raw`
    const compact = (value) => (value || "").replace(/\s+/g, " ").trim();
    const lower = (value) => compact(value).toLowerCase();
    const cssEscape = (value) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    const matchesText = (actual, expected, exact) => {
      if (expected == null || expected === "") return true;
      const a = lower(actual);
      const e = lower(expected);
      return exact ? a === e : a.includes(e);
    };
    const textOf = (el) => compact(el.innerText || el.textContent || "");
    const isVisible = (el) => {
      if (!el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const labelText = (el) => {
      if ("labels" in el && el.labels && el.labels.length > 0) {
        return compact(Array.from(el.labels).map((label) => label.innerText || label.textContent || "").join(" "));
      }
      return "";
    };
    const accessibleName = (el) => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return compact(ariaLabel);
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
          .join(" ");
        if (compact(text)) return compact(text);
      }
      const label = labelText(el);
      if (label) return label;
      if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return compact(el.value);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return compact(el.placeholder || el.value || "");
      if (el instanceof HTMLImageElement) return compact(el.alt || "");
      return textOf(el);
    };
    const implicitRole = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return lower(explicit.split(/\s+/)[0]);
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && el.hasAttribute("href")) return "link";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return el.multiple ? "listbox" : "combobox";
      if (tag === "img") return "img";
      if (el.isContentEditable) return "textbox";
      if (tag === "input") {
        const type = lower(el.getAttribute("type") || "text");
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (["email", "password", "search", "tel", "text", "url", ""].includes(type)) return "textbox";
        if (type === "number") return "spinbutton";
      }
      return "";
    };
    const cssPath = (el) => {
      if (el.id) return "#" + cssEscape(el.id);
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
      if (testId) return "[" + (el.hasAttribute("data-testid") ? "data-testid" : el.hasAttribute("data-test-id") ? "data-test-id" : "data-test") + "=\"" + cssEscape(testId) + "\"]";
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        const tag = node.tagName.toLowerCase();
        const name = node.getAttribute("name");
        if (name) {
          parts.unshift(tag + "[name=\"" + cssEscape(name) + "\"]");
          break;
        }
        const siblings = Array.from(node.parentElement?.children || []).filter((child) => child.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const elementInfo = (el) => {
      const rect = el.getBoundingClientRect();
      const info = {
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        role: implicitRole(el) || undefined,
        name: accessibleName(el) || undefined,
        text: textOf(el).slice(0, 300),
        visible: isVisible(el),
        disabled: "disabled" in el ? !!el.disabled : undefined,
        value: "value" in el ? el.value : undefined,
        checked: "checked" in el ? !!el.checked : undefined,
        bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
      return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined && value !== ""));
    };
    const queryAll = (selector) => {
      try {
        return { ok: true, elements: Array.from(document.querySelectorAll(selector)) };
      } catch (error) {
        return { ok: false, error: "Invalid CSS selector " + selector + ": " + error.message };
      }
    };
    const leafTextMatches = (el, expected, exact) => {
      if (!matchesText(textOf(el), expected, exact)) return false;
      return !Array.from(el.children).some((child) => matchesText(textOf(child), expected, exact));
    };
    const findElements = (spec) => {
      const by = spec.by || (spec.selector || spec.css ? "css" : "");
      const exact = !!spec.exact;
      if (by === "css") return queryAll(spec.selector || spec.css);
      if (by === "text") {
        return { ok: true, elements: Array.from(document.querySelectorAll("body *")).filter((el) => leafTextMatches(el, spec.text || spec.name, exact)) };
      }
      if (by === "role") {
        return { ok: true, elements: Array.from(document.querySelectorAll("body *")).filter((el) => implicitRole(el) === lower(spec.role) && matchesText(accessibleName(el), spec.name, exact)) };
      }
      if (by === "test_id" || by === "testId") {
        const wanted = spec.test_id || spec.testId || spec.name;
        const candidates = Array.from(document.querySelectorAll("[data-testid], [data-test-id], [data-test]"));
        return { ok: true, elements: candidates.filter((el) => [el.getAttribute("data-testid"), el.getAttribute("data-test-id"), el.getAttribute("data-test")].some((value) => matchesText(value, wanted, true))) };
      }
      if (by === "label") {
        const wanted = spec.label || spec.name;
        const controls = [];
        for (const label of Array.from(document.querySelectorAll("label"))) {
          if (!matchesText(textOf(label), wanted, exact)) continue;
          const control = label.control || label.querySelector("input, textarea, select, button");
          if (control) controls.push(control);
        }
        return { ok: true, elements: controls };
      }
      if (by === "placeholder") {
        const wanted = spec.placeholder || spec.name;
        return { ok: true, elements: Array.from(document.querySelectorAll("[placeholder]")).filter((el) => matchesText(el.getAttribute("placeholder"), wanted, exact)) };
      }
      if (by === "name") {
        return { ok: true, elements: Array.from(document.querySelectorAll("[name]")).filter((el) => matchesText(el.getAttribute("name"), spec.name, true)) };
      }
      return { ok: false, error: "Unsupported locator strategy: " + by };
    };
    const locate = (spec, options) => {
      const found = findElements(spec);
      if (!found.ok) return { ok: false, error: found.error, found: false, count: 0, visible_count: 0, matches: [] };
      const all = found.elements;
      const visible = all.filter(isVisible);
      const returned = (options.includeHidden ? all : visible).slice(0, options.limit || 20).map(elementInfo);
      return {
        ok: true,
        found: returned.length > 0,
        count: all.length,
        visible_count: visible.length,
        matches: returned,
      };
    };
  `;
}

function formStateRuntimeScript(): string {
  return String.raw`
    const compact = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (el) => {
      if (!el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const controlValue = (el) => {
      if (el instanceof HTMLSelectElement) {
        if (el.multiple) return Array.from(el.selectedOptions).map((option) => option.value);
        return el.value;
      }
      if (el instanceof HTMLInputElement && el.type === "checkbox") return el.checked;
      if (el instanceof HTMLInputElement && el.type === "radio") return el.checked ? el.value : null;
      return "value" in el ? el.value : null;
    };
    const describeControl = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      value: controlValue(el),
      raw_value: "value" in el ? el.value : undefined,
      checked: "checked" in el ? !!el.checked : undefined,
      disabled: "disabled" in el ? !!el.disabled : undefined,
      visible: isVisible(el),
      text: compact(el.innerText || el.textContent || "").slice(0, 200) || undefined,
    });
    const summarizeGroup = (controls) => {
      const radioControls = controls.filter((el) => el instanceof HTMLInputElement && el.type === "radio");
      if (radioControls.length > 0) {
        const checked = radioControls.find((el) => el.checked);
        return {
          kind: "radio_group",
          value: checked ? checked.value : null,
          controls: radioControls.map(describeControl),
        };
      }
      const checkboxControls = controls.filter((el) => el instanceof HTMLInputElement && el.type === "checkbox");
      if (checkboxControls.length > 1) {
        return {
          kind: "checkbox_group",
          value: checkboxControls.filter((el) => el.checked).map((el) => el.value),
          controls: checkboxControls.map(describeControl),
        };
      }
      return {
        kind: controls.length === 1 ? "field" : "field_group",
        value: controls.length === 1 ? controlValue(controls[0]) : controls.map(controlValue),
        controls: controls.map(describeControl),
      };
    };
    const readFormState = (input) => {
      let root = document;
      if (input.form_selector) {
        try {
          root = document.querySelector(input.form_selector);
        } catch (error) {
          return { ok: false, error: "Invalid form_selector " + input.form_selector + ": " + error.message };
        }
        if (!root) return { ok: false, error: "No element matches form_selector " + input.form_selector };
      }
      const controls = Array.from(root.querySelectorAll("input[name], textarea[name], select[name], button[name]"));
      const wantedNames = input.names || Array.from(new Set(controls.map((el) => el.getAttribute("name")).filter(Boolean)));
      const fields = {};
      const missing = [];
      for (const name of wantedNames) {
        const matches = controls.filter((el) => el.getAttribute("name") === name);
        if (matches.length === 0) {
          missing.push(name);
          continue;
        }
        fields[name] = summarizeGroup(matches);
      }
      return {
        ok: true,
        form_selector: input.form_selector || null,
        fields,
        missing,
      };
    };
  `;
}
