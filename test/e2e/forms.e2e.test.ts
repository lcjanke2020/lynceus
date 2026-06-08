// L3 form driving: select_option / check / uncheck / fill / suggest_locator
// against the sample app's <select id="fruit">, checkbox #subscribe, and the
// #name-input text field. Each control echoes on `change`/`input`, so these
// specs confirm the tools dispatched framework-observable events — not just
// mutated a property — and that fill REPLACES rather than appends.

import { describe, it, expect, beforeEach } from "vitest";
import { buildToolMap, call, callExpectError, attachToTestChrome, sampleAppUrl } from "./helpers/build-tools.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

async function setup(): Promise<void> {
  await attachToTestChrome(tools);
  await call(tools, "navigate", { url: sampleAppUrl(), wait: "load" });
}

describe("form driving (e2e)", () => {
  beforeEach(async () => setup());

  it("select_option sets a <select> by value and dispatches change", async () => {
    const r = await call<{ status: string; selected: Array<{ value: string }> }>(tools, "select_option", {
      selector: "#fruit",
      option_value: "cherry",
    });
    expect(r.status).toBe("selected");
    expect(r.selected[0]?.value).toBe("cherry");

    const fs = await call<{ fields: Record<string, { value: unknown }> }>(tools, "get_form_state", {
      names: ["fruit"],
    });
    expect(fs.fields.fruit?.value).toBe("cherry");

    const echo = await call<{ html: string }>(tools, "get_element_html", { selector: "#fruit-echo" });
    expect(echo.html).toContain("cherry");
  });

  it("select_option also matches by option_label and option_index", async () => {
    const byLabel = await call<{ selected: Array<{ value: string }> }>(tools, "select_option", {
      selector: "#fruit",
      option_label: "Banana",
    });
    expect(byLabel.selected[0]?.value).toBe("banana");

    const byIndex = await call<{ selected: Array<{ value: string }> }>(tools, "select_option", {
      selector: "#fruit",
      option_index: 0,
    });
    expect(byIndex.selected[0]?.value).toBe("apple");
  });

  // Read the live selection set of #fruits-multi straight from the DOM.
  const selectedMulti = async (): Promise<string> =>
    (
      await call<{ value: string }>(tools, "evaluate", {
        expression: `Array.from(document.getElementById("fruits-multi").selectedOptions).map((o) => o.value).join(",")`,
        return_by_value: true,
      })
    ).value;

  it("select_option multiple:true selects every match on a <select multiple> and dispatches change", async () => {
    const r = await call<{ status: string; selected: Array<{ value: string }>; multiple: boolean }>(tools, "select_option", {
      selector: "#fruits-multi",
      option_value: ["apple", "cherry"],
      multiple: true,
    });
    expect(r.status).toBe("selected");
    expect(r.selected.map((s) => s.value)).toEqual(["apple", "cherry"]);
    expect(r.multiple).toBe(true);
    expect(await selectedMulti()).toBe("apple,cherry");

    const echo = await call<{ html: string }>(tools, "get_element_html", { selector: "#fruits-multi-echo" });
    expect(echo.html).toContain("apple,cherry");
  });

  it("select_option without multiple selects only the first match, even on a <select multiple>", async () => {
    // Proves the `multiple` flag is honored (not dead code): omitting it must
    // NOT select-all on a <select multiple>; it takes the first match only.
    const r = await call<{ selected: Array<{ value: string }> }>(tools, "select_option", {
      selector: "#fruits-multi",
      option_value: ["apple", "cherry"],
    });
    expect(r.selected).toHaveLength(1);
    expect(r.selected[0]?.value).toBe("apple");
    expect(await selectedMulti()).toBe("apple");
  });

  it("select_option multiple:true with no match leaves the existing selection intact and returns not_found", async () => {
    await call(tools, "select_option", { selector: "#fruits-multi", option_value: ["apple", "cherry"], multiple: true });
    expect(await selectedMulti()).toBe("apple,cherry");

    // A zero-match call must not deselect what was already chosen.
    const err = await callExpectError(tools, "select_option", { selector: "#fruits-multi", option_value: "durian", multiple: true });
    expect(err.error).toBe("not_found");
    expect(await selectedMulti()).toBe("apple,cherry");
  });

  it("check / uncheck are idempotent and dispatch change", async () => {
    expect((await call<{ status: string }>(tools, "check", { selector: "#subscribe" })).status).toBe("checked");
    expect((await call<{ status: string }>(tools, "check", { selector: "#subscribe" })).status).toBe("already-checked");

    const onEcho = await call<{ html: string }>(tools, "get_element_html", { selector: "#subscribe-echo" });
    expect(onEcho.html).toContain("true");

    expect((await call<{ status: string }>(tools, "uncheck", { selector: "#subscribe" })).status).toBe("unchecked");
    expect((await call<{ status: string }>(tools, "uncheck", { selector: "#subscribe" })).status).toBe("already-unchecked");
  });

  it("fill replaces existing contents (not append)", async () => {
    await call(tools, "fill", { by: "css", css: "#name-input", value: "Bob" });
    const r = await call<{ status: string; value_length: number }>(tools, "fill", {
      by: "css",
      css: "#name-input",
      value: "Ada",
    });
    expect(r.status).toBe("filled");
    expect(r.value_length).toBe(3);

    await waitFor(
      async () => {
        const html = await call<{ html: string }>(tools, "get_element_html", { selector: "#name-echo" });
        return html.html.includes("Ada") && !html.html.includes("Bob") ? html : null;
      },
      { describe: "#name-echo shows exactly 'Ada' (replaced, not appended)" },
    );
  });

  it("fill refuses non-text controls with wrong_element (<select>, checkbox)", async () => {
    // Both expose a `value` property, but neither is a free-text field — fill
    // must reject them rather than clobber the selected option / submission value.
    const onSelect = await callExpectError(tools, "fill", { selector: "#fruit", value: "x" });
    expect(onSelect.error).toBe("wrong_element");
    const onCheckbox = await callExpectError(tools, "fill", { selector: "#subscribe", value: "x" });
    expect(onCheckbox.error).toBe("wrong_element");

    // The real text input is still fillable.
    const ok = await call<{ status: string }>(tools, "fill", { selector: "#name-input", value: "ok" });
    expect(ok.status).toBe("filled");
  });

  it("mutating tools surface invalid_locator for a malformed CSS selector", async () => {
    // An unparseable selector (vs. a valid selector that matches nothing) is an
    // invalid locator, mirroring locate/wait_for — not not_found.
    const err = await callExpectError(tools, "fill", { selector: "input[", value: "x" });
    expect(err.error).toBe("invalid_locator");
  });

  it("suggest_locator surfaces invalid_selector for a malformed CSS selector", async () => {
    const err = await callExpectError(tools, "suggest_locator", { selector: "input[" });
    expect(err.error).toBe("invalid_selector");
  });

  it("suggest_locator ranks candidates for the button (node_id path)", async () => {
    const node = await call<{ node_id: number }>(tools, "query_selector", { selector: "#go" });
    const r = await call<{
      candidates: Array<{ locator: { by: string }; match_count: number; resolves_to_target: boolean }>;
      recommended: number | null;
    }>(tools, "suggest_locator", { node_id: node.node_id });

    expect(r.candidates.length).toBeGreaterThan(0);
    const cssCand = r.candidates.find((c) => c.locator.by === "css");
    expect(cssCand?.resolves_to_target).toBe(true);
    expect(cssCand?.match_count).toBe(1);
    expect(r.recommended).not.toBeNull();
  });
});
