import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDomTools } from "../../src/tools/dom.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";

autoReset();

const tools = captureTools(registerDomTools);
const querySel = tools.get("query_selector")!;
const getHtml = tools.get("get_element_html")!;
const locate = tools.get("locate")!;
const waitFor = tools.get("wait_for")!;
const getFormState = tools.get("get_form_state")!;
const click = tools.get("click")!;
const typeText = tools.get("type_text")!;
const pressKey = tools.get("press_key")!;
const screenshot = tools.get("screenshot")!;

describe("query_selector", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await querySel.handler({ selector: "#go" }))?.error).toBe("no_session");
  });

  it("returns {found:false} when no element matches (default fake response)", async () => {
    setupSession();
    const r = parseOkEnvelope<{ found: boolean }>(await querySel.handler({ selector: "#missing" }));
    expect(r.found).toBe(false);
  });

  it("returns tag/attrs/preview when an element matches", async () => {
    const { fake } = setupSession();
    fake.respond("DOM.querySelector", () => ({ nodeId: 42 }));
    fake.respond("DOM.describeNode", () => ({
      node: {
        nodeId: 42,
        nodeName: "BUTTON",
        attributes: ["id", "go", "class", "btn primary"],
        backendNodeId: 100,
      },
    }));
    const r = parseOkEnvelope<any>(await querySel.handler({ selector: "#go" }));
    expect(r.found).toBe(true);
    expect(r.node_id).toBe(42);
    expect(r.tag).toBe("button");
    expect(r.attrs).toEqual({ id: "go", class: "btn primary" });
    expect(r.backend_node_id).toBe(100);
  });
});

describe("get_element_html", () => {
  it("missing_arg when neither selector nor node_id supplied", async () => {
    setupSession();
    const err = parseErrorEnvelope(await getHtml.handler({}));
    expect(err?.error).toBe("missing_arg");
  });

  it("not_found when selector matches nothing", async () => {
    setupSession(); // default DOM.querySelector returns nodeId:0
    const err = parseErrorEnvelope(await getHtml.handler({ selector: "#nope" }));
    expect(err?.error).toBe("not_found");
  });

  it("returns outer HTML by default", async () => {
    const { fake } = setupSession();
    fake.respond("DOM.querySelector", () => ({ nodeId: 5 }));
    fake.respond("DOM.getOuterHTML", () => ({ outerHTML: "<div>hi</div>" }));
    const r = parseOkEnvelope<{ html: string; node_id: number }>(
      await getHtml.handler({ selector: "div" }),
    );
    expect(r.html).toBe("<div>hi</div>");
    expect(r.node_id).toBe(5);
  });

  it("derives inner HTML when outer:false", async () => {
    const { fake } = setupSession();
    fake.respond("DOM.querySelector", () => ({ nodeId: 6 }));
    fake.respond("DOM.getOuterHTML", () => ({ outerHTML: "<span>inside</span>" }));
    const r = parseOkEnvelope<{ html: string }>(
      await getHtml.handler({ selector: "span", outer: false }),
    );
    expect(r.html).toBe("inside");
  });

  it("accepts node_id directly without re-resolving", async () => {
    const { fake } = setupSession();
    fake.respond("DOM.getOuterHTML", () => ({ outerHTML: "<p>x</p>" }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ html: string }>(await getHtml.handler({ node_id: 99 }));
    expect(r.html).toBe("<p>x</p>");
    // Critical: should NOT have called DOM.querySelector — node_id bypasses resolution.
    expect(fake.sentCalls.find((c) => c.method === "DOM.querySelector")).toBeUndefined();
  });
});

describe("locate", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await locate.handler({ by: "css", selector: "#go" }))?.error).toBe("no_session");
  });

  it("missing_arg when no locator strategy can be inferred", async () => {
    setupSession();
    expect(parseErrorEnvelope(await locate.handler({}))?.error).toBe("missing_arg");
  });

  it("returns locator results from Runtime.evaluate", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: { ok: true, found: true, count: 1, visible_count: 1, matches: [{ tag: "button", selector: "#go" }] },
      },
    }));
    const r = parseOkEnvelope<any>(await locate.handler({ by: "css", selector: "#go" }));
    expect(r.found).toBe(true);
    expect(r.count).toBe(1);
    expect(r.matches).toHaveLength(1);
  });

  it("throws invalid_locator when the runtime returns ok:false", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: false, error: "bad selector" } },
    }));
    expect(parseErrorEnvelope(await locate.handler({ by: "css", selector: "[[[" }))?.error).toBe("invalid_locator");
  });
});

describe("wait_for", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await waitFor.handler({ by: "css", selector: "#go" }))?.error).toBe("no_session");
  });

  it("returns immediately when condition is met on first poll", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: { ok: true, found: true, count: 1, visible_count: 1, matches: [{ tag: "div" }] },
      },
    }));
    const r = parseOkEnvelope<any>(await waitFor.handler({ by: "css", selector: "#go", timeout_ms: 100 }));
    expect(r.state).toBe("visible");
    expect(r.elapsed_ms).toBeLessThanOrEqual(100);
  });

  it("throws timeout when condition never met", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: { ok: true, found: false, count: 0, visible_count: 0, matches: [] },
      },
    }));
    const err = parseErrorEnvelope(
      await waitFor.handler({ by: "css", selector: "#missing", timeout_ms: 50, interval_ms: 10 }),
    );
    expect(err?.error).toBe("timeout");
  });
});

describe("get_form_state", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getFormState.handler({}))?.error).toBe("no_session");
  });

  it("returns form state from Runtime.evaluate", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: {
          ok: true,
          form_selector: null,
          fields: { email: { kind: "field", value: "test@example.com", controls: [] } },
          missing: [],
        },
      },
    }));
    const r = parseOkEnvelope<any>(await getFormState.handler({}));
    expect(r.ok).toBe(true);
    expect(r.fields.email.value).toBe("test@example.com");
  });

  it("throws invalid_selector when the runtime returns ok:false", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: false, error: "bad form_selector" } },
    }));
    expect(parseErrorEnvelope(await getFormState.handler({ form_selector: "#bad" }))?.error).toBe("invalid_selector");
  });
});

describe("click", () => {
  it("not_found when Runtime.evaluate reports no element", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: false, error: "no match" } },
    }));
    const err = parseErrorEnvelope(await click.handler({ selector: "#none" }));
    expect(err?.error).toBe("not_found");
  });

  it("dispatches mouse moved + pressed + released at the element's center", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: true, x: 50, y: 100 } },
    }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ clicked: string; x: number; y: number }>(
      await click.handler({ selector: "#go" }),
    );
    expect(r).toEqual({ clicked: "#go", x: 50, y: 100 });
    const mouseEvents = fake.sentCalls
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params.type);
    expect(mouseEvents).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  it("the eval expression includes the selector escaped via JSON.stringify (XSS guard)", async () => {
    // Critical: the click expression embeds the user's selector. JSON.stringify
    // is the only safe encoding — a naive backtick interpolation would let
    // a selector like '"); alert(1); ("' break out of the string literal.
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: true, x: 0, y: 0 } },
    }));
    fake.clearSentCalls();
    await click.handler({ selector: 'a"; alert("x"); //' });
    const evalCall = fake.sentCalls.find((c) => c.method === "Runtime.evaluate");
    // Must contain the JSON-stringified form (escaped quotes), NOT the raw form.
    expect(evalCall?.params.expression).toContain(JSON.stringify('a"; alert("x"); //'));
    expect(evalCall?.params.expression).not.toContain('alert("x")');
  });
});

describe("type_text", () => {
  it("not_found when focus eval returns false", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({ result: { type: "boolean", value: false } }));
    const err = parseErrorEnvelope(await typeText.handler({ selector: "#none", text: "x" }));
    expect(err?.error).toBe("not_found");
  });

  it("focuses the element then dispatches Input.insertText", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({ result: { type: "boolean", value: true } }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ typed: number; into: string }>(
      await typeText.handler({ selector: "#field", text: "hello" }),
    );
    expect(r.typed).toBe(5);
    expect(r.into).toBe("#field");
    expect(fake.sentCalls.find((c) => c.method === "Input.insertText")?.params.text).toBe("hello");
  });

  it("clear_first injects el.value='' into the focus eval", async () => {
    const { fake } = setupSession();
    fake.respond("Runtime.evaluate", () => ({ result: { type: "boolean", value: true } }));
    fake.clearSentCalls();
    await typeText.handler({ selector: "#in", text: "x", clear_first: true });
    const evalCall = fake.sentCalls.find((c) => c.method === "Runtime.evaluate");
    expect(evalCall?.params.expression).toContain("el.value = ''");
  });
});

describe("press_key", () => {
  it("dispatches keyDown then keyUp with the same key", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    expect(parseOkEnvelope<any>(await pressKey.handler({ key: "Enter" }))).toEqual({ pressed: "Enter" });
    const keyEvents = fake.sentCalls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keyEvents.map((c) => c.params.type)).toEqual(["keyDown", "keyUp"]);
    expect(keyEvents.every((c) => c.params.key === "Enter")).toBe(true);
  });
});

describe("screenshot", () => {
  it("returns base64 PNG by default (real PNG header bytes)", async () => {
    setupSession();
    const r = parseOkEnvelope<{ format: string; base64: string }>(await screenshot.handler({}));
    expect(r.format).toBe("png");
    expect(r.base64.startsWith("iVBOR")).toBe(true);
  });

  it("writes to a path when supplied and returns {saved, bytes}", async () => {
    setupSession();
    const dir = await mkdtemp(join(tmpdir(), "cdpmcp-shot-"));
    try {
      const path = join(dir, "shot.png");
      const r = parseOkEnvelope<{ saved: string; bytes: number }>(
        await screenshot.handler({ path }),
      );
      expect(r.saved).toBe(path);
      const buf = await readFile(path);
      // PNG magic bytes
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards format=jpeg and quality together; quality alone (no format) is ignored", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    await screenshot.handler({ format: "jpeg", quality: 80 });
    const callA = fake.sentCalls.find((c) => c.method === "Page.captureScreenshot");
    expect(callA?.params).toMatchObject({ format: "jpeg", quality: 80 });

    fake.clearSentCalls();
    await screenshot.handler({ quality: 80 }); // no format → default png → quality dropped
    const callB = fake.sentCalls.find((c) => c.method === "Page.captureScreenshot");
    expect(callB?.params).toMatchObject({ format: "png" });
    expect(callB?.params.quality).toBeUndefined();
  });

  it("captureBeyondViewport reflects full_page", async () => {
    const { fake } = setupSession();
    fake.clearSentCalls();
    await screenshot.handler({ full_page: true });
    expect(fake.sentCalls[0]?.params.captureBeyondViewport).toBe(true);
  });
});

describe("registration metadata", () => {
  it("registers exactly the nine DOM tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "click",
      "get_element_html",
      "get_form_state",
      "locate",
      "press_key",
      "query_selector",
      "screenshot",
      "type_text",
      "wait_for",
    ]);
  });
});
