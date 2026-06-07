import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { requireSession } from "../session/state.js";
import { ToolError } from "../util/errors.js";
import { registerJsonTool } from "./_register.js";
import { locatorShape, type LocatorSpec } from "../locator.js";
import { normalizeLocator, locatorHelpersScript, locatorReadScript } from "./_locator_runtime.js";

const waitStateSchema = z.enum(["visible", "hidden", "attached", "detached"]);

type WaitState = z.infer<typeof waitStateSchema>;

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
    ${locatorHelpersScript()}${locatorReadScript()}
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
