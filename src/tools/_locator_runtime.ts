/**
 * Shared, tools-side locator plumbing.
 *
 * The canonical LocatorSpec contract lives in `../locator.ts` (zod-only, public).
 * This module adds the parts that are specific to running locators *inside the
 * page* and to the lynceus tool error envelope:
 *   - `normalizeLocator` — the contract normalizer, re-wrapping `LocatorError`
 *     as the repo's structured `ToolError` (preserving its error code).
 *   - `locatorHelpersScript()` — the in-page helper library (accessibility
 *     heuristics, visibility, `findElements`, `elementInfo`).
 *   - `locatorReadScript()` — the read-only `locate(spec, options)` entry.
 *   - `mutationHelpersScript()` — `resolveOne(spec)` + `fireEvents(el, types)`,
 *     used by the form-driving tools to resolve and mutate an element with the
 *     exact same matching semantics as `locate`.
 *
 * Both `dom.ts` (read) and the form-driving tools (drive) compose these so a
 * locator behaves identically whether it is queried or acted upon.
 */
import { ToolError } from "../util/errors.js";
import {
  normalizeLocator as normalizeLocatorContract,
  LocatorError,
  type LocatorSpec,
} from "../locator.js";

/**
 * Normalize a LocatorSpec for tool use, surfacing failures as the repo's
 * structured `ToolError` (historically `missing_arg`) instead of the contract's
 * plain `LocatorError`.
 */
export function normalizeLocator(input: LocatorSpec): LocatorSpec {
  try {
    return normalizeLocatorContract(input);
  } catch (e) {
    if (e instanceof LocatorError) throw new ToolError(e.code, e.message);
    throw e;
  }
}

/**
 * In-page helper library: text/visibility utilities, the accessibility
 * heuristics (`implicitRole`, `accessibleName`, `cssPath`), `elementInfo`, and
 * `findElements(spec)`. Inject this into a `Runtime.evaluate` expression before
 * `locatorReadScript()` or `mutationHelpersScript()`.
 */
export function locatorHelpersScript(): string {
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
  `;
}

/**
 * The read-only `locate(spec, options)` entry. Compose after
 * `locatorHelpersScript()`; returns `{ ok, error?, found, count, visible_count, matches }`.
 */
export function locatorReadScript(): string {
  return String.raw`
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

/**
 * Mutation helpers for the form-driving tools. Compose after
 * `locatorHelpersScript()`:
 *   - `resolveOne(spec)` → `{ ok, el?, count, visible_count, error?, code? }`,
 *     preferring visible matches (the same visible-first bias `locate` reports)
 *     and picking the first match. On failure `code` distinguishes an
 *     invalid/unsupported locator (`invalid_locator`, mirroring locate/wait_for)
 *     from a valid locator that matched nothing (`not_found`).
 *   - `fireEvents(el, types)` → dispatch bubbling events (e.g. `input`/`change`)
 *     so app frameworks observe a programmatic mutation.
 */
export function mutationHelpersScript(): string {
  return String.raw`
    const resolveOne = (spec) => {
      const found = findElements(spec);
      // findElements only returns !ok for an invalid/unsupported locator (bad CSS
      // selector or unknown strategy) — the same condition locate/wait_for report
      // as invalid_locator. A valid locator that simply matches nothing is the
      // distinct not_found case below.
      if (!found.ok) return { ok: false, error: found.error, code: "invalid_locator" };
      const all = found.elements;
      const visible = all.filter(isVisible);
      const pick = visible.length ? visible : all;
      if (pick.length === 0) return { ok: false, error: "no element matches locator", code: "not_found" };
      return { ok: true, el: pick[0], count: all.length, visible_count: visible.length };
    };
    const fireEvents = (el, types) => {
      for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
    };
  `;
}
