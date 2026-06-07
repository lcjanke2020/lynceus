import { describe, it, expect } from "vitest";
import { registerFormTools } from "../../src/tools/forms.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerFormTools);
const selectOption = tools.get("select_option")!;
const check = tools.get("check")!;
const uncheck = tools.get("uncheck")!;
const fill = tools.get("fill")!;
const suggest = tools.get("suggest_locator")!;

/** Make a Runtime.evaluate responder that returns a by-value page result. */
const evalValue = (value: unknown) => () => ({ result: { type: "object", value } });

describe("select_option", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await selectOption.handler({ selector: "#s", option_value: "a" }))?.error).toBe("no_session");
  });

  it("missing_arg when no option_value/option_label/option_index supplied", async () => {
    setupSession();
    expect(parseErrorEnvelope(await selectOption.handler({ selector: "#s" }))?.error).toBe("missing_arg");
  });

  it("returns status:selected with the resolved option", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, selected: [{ value: "b", label: "B", index: 1 }], multiple: false, count: 1 }));
    const r = parseOkEnvelope<any>(await selectOption.handler({ selector: "#s", option_value: "b" }));
    expect(r.status).toBe("selected");
    expect(r.selected).toEqual([{ value: "b", label: "B", index: 1 }]);
    expect(r.multiple).toBe(false);
  });

  it("supports multi-select results", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, selected: [{ value: "a", label: "A", index: 0 }, { value: "c", label: "C", index: 2 }], multiple: true, count: 1 }));
    const r = parseOkEnvelope<any>(await selectOption.handler({ selector: "#s", option_value: ["a", "c"], multiple: true }));
    expect(r.selected).toHaveLength(2);
    expect(r.multiple).toBe(true);
  });

  it("wrong_element when target is not a <select>", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: false, error: "element is not a <select>", code: "wrong_element" }));
    expect(parseErrorEnvelope(await selectOption.handler({ selector: "#s", option_value: "b" }))?.error).toBe("wrong_element");
  });

  it("not_found when no option matched", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: false, error: "no <option> matched", code: "not_found" }));
    expect(parseErrorEnvelope(await selectOption.handler({ selector: "#s", option_value: "zzz" }))?.error).toBe("not_found");
  });

  it("embeds the locator via JSON.stringify (XSS guard)", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, selected: [{ value: "x", index: 0 }], multiple: false, count: 1 }));
    fake.clearSentCalls();
    const evil = 'a"; alert("x"); //';
    await selectOption.handler({ selector: evil, option_value: "x" });
    const evalCall = fake.sentCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params.expression).toContain(JSON.stringify(evil));
    expect(evalCall?.params.expression).not.toContain('alert("x")');
  });
});

describe("check / uncheck", () => {
  it("check returns status:checked when it flips the control", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, changed: true, checked: true, count: 1 }));
    const r = parseOkEnvelope<any>(await check.handler({ selector: "#agree" }));
    expect(r.status).toBe("checked");
    expect(r.checked).toBe(true);
  });

  it("check returns status:already-checked (success, not error) when already checked", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, changed: false, checked: true, count: 1 }));
    const envelope = await check.handler({ selector: "#agree" });
    expect(envelope.isError).toBeFalsy();
    expect(parseOkEnvelope<any>(envelope).status).toBe("already-checked");
  });

  it("uncheck returns status:unchecked / already-unchecked", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, changed: true, checked: false, count: 1 }));
    expect(parseOkEnvelope<any>(await uncheck.handler({ selector: "#agree" })).status).toBe("unchecked");
    fake.respond("Runtime.evaluate", evalValue({ ok: true, changed: false, checked: false, count: 1 }));
    const envelope = await uncheck.handler({ selector: "#agree" });
    expect(envelope.isError).toBeFalsy();
    expect(parseOkEnvelope<any>(envelope).status).toBe("already-unchecked");
  });

  it("wrong_element when not a checkbox/radio", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: false, error: "element is not a checkbox or radio", code: "wrong_element" }));
    expect(parseErrorEnvelope(await check.handler({ selector: "#div" }))?.error).toBe("wrong_element");
  });
});

describe("fill", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await fill.handler({ selector: "#n", value: "x" }))?.error).toBe("no_session");
  });

  it("returns status:filled with value_length", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, tag: "input", count: 1 }));
    const r = parseOkEnvelope<any>(await fill.handler({ selector: "#name", value: "Ada" }));
    expect(r.status).toBe("filled");
    expect(r.value_length).toBe(3);
    expect(r.tag).toBe("input");
  });

  it("embeds the value via JSON.stringify (XSS guard)", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, tag: "input", count: 1 }));
    fake.clearSentCalls();
    const evil = 'x"; alert("pwned"); //';
    await fill.handler({ selector: "#name", value: evil });
    const evalCall = fake.sentCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params.expression).toContain(JSON.stringify(evil));
    expect(evalCall?.params.expression).not.toContain('alert("pwned")');
  });

  it("wrong_element when not fillable", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: false, error: "not fillable", code: "wrong_element" }));
    expect(parseErrorEnvelope(await fill.handler({ selector: "#div", value: "x" }))?.error).toBe("wrong_element");
  });
});

describe("suggest_locator", () => {
  const candidates = [
    { locator: { by: "role", role: "button", name: "Go" }, match_count: 1, unambiguous: true, resolves_to_target: true },
    { locator: { by: "css", css: "#go" }, match_count: 1, unambiguous: true, resolves_to_target: true },
  ];

  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await suggest.handler({ selector: "#go" }))?.error).toBe("no_session");
  });

  it("missing_arg when neither node_id nor selector supplied", async () => {
    setupSession();
    expect(parseErrorEnvelope(await suggest.handler({}))?.error).toBe("missing_arg");
  });

  it("selector path: returns ranked candidates + recommended", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: true, candidates, recommended: 0 }));
    const r = parseOkEnvelope<any>(await suggest.handler({ selector: "#go" }));
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].unambiguous).toBe(true);
    expect(r.recommended).toBe(0);
  });

  it("node_id path: resolves the node then calls a function on it", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.callFunctionOn", () => ({ result: { type: "object", value: { ok: true, candidates, recommended: 1 } } }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<any>(await suggest.handler({ node_id: 42 }));
    expect(r.recommended).toBe(1);
    const methods = fake.sentCalls.map((c) => c.method);
    expect(methods).toContain("DOM.resolveNode");
    expect(methods).toContain("Runtime.callFunctionOn");
  });

  it("not_found when the selector matches nothing", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", evalValue({ ok: false, error: "no element matches selector", code: "not_found" }));
    expect(parseErrorEnvelope(await suggest.handler({ selector: "#nope" }))?.error).toBe("not_found");
  });
});
