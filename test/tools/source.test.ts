import { describe, it, expect } from "vitest";
import { registerSourceTools } from "../../src/tools/source.js";
import { setupSession, autoReset } from "../setup.js";
import { captureTools, parseErrorEnvelope, parseOkEnvelope } from "../handler-registry.js";
import { seedMappedScript } from "../helpers/source-maps.js";

autoReset();

const tools = captureTools(registerSourceTools);
const list = tools.get("list_scripts")!;
const getSrc = tools.get("get_script_source")!;
const getSource = tools.get("get_source")!;
const resolve = tools.get("resolve_source_position")!;

describe("list_scripts", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await list.handler({}))?.error).toBe("no_session");
  });

  it("filters out scripts without a URL", async () => {
    const { session } = setupSession();
    session.scripts.upsert({
      scriptId: "anon",
      url: "", // anonymous inline; should be filtered
      startLine: 0, startColumn: 0, endLine: 1, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    seedMappedScript({ scriptId: "s1", url: "http://x/a.js", source: "src/a.ts" });
    const r = parseOkEnvelope<any[]>(await list.handler({}));
    expect(r.map((s) => s.script_id)).toEqual(["s1"]);
  });

  it("default mapped_only=true hides scripts without a consumer", async () => {
    const { session } = setupSession();
    session.scripts.upsert({
      scriptId: "raw", url: "http://x/raw.js",
      startLine: 0, startColumn: 0, endLine: 1, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    seedMappedScript({ scriptId: "mapped", url: "http://x/m.js", source: "src/m.ts" });
    const onlyMapped = parseOkEnvelope<any[]>(await list.handler({}));
    expect(onlyMapped.map((s) => s.script_id)).toEqual(["mapped"]);
    const all = parseOkEnvelope<any[]>(await list.handler({ mapped_only: false }));
    expect(all.map((s) => s.script_id).sort()).toEqual(["mapped", "raw"]);
  });

  it("url_includes substring filter", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/vendor.js", source: "src/v.ts" });
    seedMappedScript({ scriptId: "s2", url: "http://x/app.js", source: "src/a.ts" });
    const r = parseOkEnvelope<any[]>(await list.handler({ url_includes: "app" }));
    expect(r.map((s) => s.script_id)).toEqual(["s2"]);
  });

  it("emits session_id:null for root scripts and the literal sessionId for children", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s_root", url: "http://x/main.js", source: "src/main.ts" });
    seedMappedScript({ scriptId: "s_w", url: "http://x/worker.js", source: "src/worker.ts", sessionId: "SW1" });
    const r = parseOkEnvelope<any[]>(await list.handler({ mapped_only: false }));
    const byId = new Map(r.map((s) => [s.script_id, s]));
    expect(byId.get("s_root")?.session_id).toBeNull();
    expect(byId.get("s_w")?.session_id).toBe("SW1");
  });

  it("limit caps results", async () => {
    setupSession();
    for (let i = 0; i < 5; i++) {
      seedMappedScript({ scriptId: `s${i}`, url: `http://x/${i}.js`, source: `src/${i}.ts` });
    }
    const r = parseOkEnvelope<any[]>(await list.handler({ limit: 2 }));
    expect(r).toHaveLength(2);
  });

  it("projects original_sources (capped at 30) and original_source_count", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/a.js", source: "src/foo.ts" });
    const r = parseOkEnvelope<any[]>(await list.handler({}));
    expect(r[0].original_sources).toEqual(["src/foo.ts"]);
    expect(r[0].original_source_count).toBe(1);
  });
});

describe("get_script_source", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getSrc.handler({ script_id: "s1" }))?.error).toBe("no_session");
  });

  it("forwards script_id and routes to root for omitted/null session_id", async () => {
    const { fake } = setupSession();
    fake.respond("Debugger.getScriptSource", () => ({ scriptSource: "// hello" }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ script_id: string; session_id: string | null; source: string }>(
      await getSrc.handler({ script_id: "s1" }),
    );
    expect(r.source).toBe("// hello");
    expect(r.session_id).toBeNull();
    expect(fake.sentCalls[0]?.sessionId).toBeUndefined();
    expect(fake.sentCalls[0]?.params.scriptId).toBe("s1");
  });

  it("explicit string session_id routes to that child", async () => {
    const { fake } = setupSession();
    fake.respond("Debugger.getScriptSource", () => ({ scriptSource: "// w" }));
    fake.clearSentCalls();
    const r = parseOkEnvelope<{ session_id: string }>(
      await getSrc.handler({ script_id: "s42", session_id: "SW1" }),
    );
    expect(r.session_id).toBe("SW1");
    expect(fake.sentCalls[0]?.sessionId).toBe("SW1");
  });
});

describe("get_source", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await getSource.handler({ file: "src/foo.ts" }))?.error).toBe("no_session");
  });

  it("returns the ORIGINAL TS text (embedded sourcesContent) with origin + line_count", async () => {
    setupSession();
    seedMappedScript({
      scriptId: "s1",
      url: "http://x/app.js",
      source: "src/foo.ts",
      sourceContent: "export function foo() {\n  return 42;\n}\n",
    });
    const r = parseOkEnvelope<{
      file: string; script_id: string; session_id: string | null;
      origin: string; line_count: number; source: string;
    }>(await getSource.handler({ file: "src/foo.ts" }));
    expect(r.source).toBe("export function foo() {\n  return 42;\n}\n");
    expect(r.origin).toBe("source_map");
    expect(r.file).toBe("src/foo.ts");
    expect(r.script_id).toBe("s1");
    expect(r.session_id).toBeNull();
    expect(r.line_count).toBe(3); // three addressable lines; trailing newline is not a 4th
  });

  it("no_source error (no_match) when no script's map references the file", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", sourceContent: "x" });
    const err = parseErrorEnvelope(await getSource.handler({ file: "src/never.ts" }));
    expect(err?.error).toBe("no_source");
    expect(err?.message).toContain("src/never.ts");
    expect(err?.message).toContain("list_scripts");
  });

  it("no_source error (no_content) when the map matches but carries no readable source", async () => {
    setupSession();
    // http-served, no sourcesContent → nothing embedded, nothing on disk.
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts" });
    const err = parseErrorEnvelope(await getSource.handler({ file: "src/foo.ts" }));
    expect(err?.error).toBe("no_source");
    expect(err?.message).toContain("get_script_source");
  });

  it("session_id disambiguates a worker copy from root", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s_root", url: "http://x/main.js", source: "src/main.ts", sourceContent: "ROOT" });
    seedMappedScript({ scriptId: "s_w", url: "http://x/worker.js", source: "src/main.ts", sessionId: "SW1", sourceContent: "WORKER" });
    const worker = parseOkEnvelope<{ source: string; session_id: string | null }>(
      await getSource.handler({ file: "src/main.ts", session_id: "SW1" }),
    );
    expect(worker.source).toBe("WORKER");
    expect(worker.session_id).toBe("SW1");
    const root = parseOkEnvelope<{ source: string }>(
      await getSource.handler({ file: "src/main.ts", session_id: null }),
    );
    expect(root.source).toBe("ROOT");
  });
});

describe("resolve_source_position", () => {
  it("no_session error", async () => {
    setupSession({ noClient: true });
    expect(parseErrorEnvelope(await resolve.handler({ file: "src/foo.ts", line: 7 }))?.error).toBe("no_session");
  });

  it("returns no candidates when no script's map references the file (does NOT throw no_mapping)", async () => {
    // Diagnostic tool — meant to RETURN empty so the agent can see the
    // situation, not throw. set_breakpoint is the one that errors.
    setupSession();
    const r = parseOkEnvelope<{ candidates: any[] }>(
      await resolve.handler({ file: "src/never.ts", line: 7 }),
    );
    expect(r.candidates).toEqual([]);
  });

  it("returns generated coords (1-based public line) for a mapped TS coord", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s1", url: "http://x/a.js", source: "src/foo.ts", tsLine: 7, jsLine: 1 });
    const r = parseOkEnvelope<{ query: any; candidates: any[] }>(
      await resolve.handler({ file: "src/foo.ts", line: 7 }),
    );
    expect(r.query).toEqual({ file: "src/foo.ts", line: 7, column: 0 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      script_id: "s1",
      script_url: "http://x/a.js",
      session_id: null,
      line: 1, // public is 1-based
    });
  });

  it("returns one candidate per matching script when the same TS file is in multiple scripts", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s_v", url: "http://x/vendor.js", source: "src/util.ts", tsLine: 3, jsLine: 1 });
    seedMappedScript({ scriptId: "s_a", url: "http://x/app.js", source: "src/util.ts", tsLine: 3, jsLine: 1 });
    const r = parseOkEnvelope<{ candidates: any[] }>(await resolve.handler({ file: "src/util.ts", line: 3 }));
    expect(r.candidates).toHaveLength(2);
    expect(new Set(r.candidates.map((c) => c.script_id))).toEqual(new Set(["s_v", "s_a"]));
  });

  it("includes session_id on per-script candidates for cross-session disambiguation", async () => {
    setupSession();
    seedMappedScript({ scriptId: "s_root", url: "http://x/main.js", source: "src/main.ts", tsLine: 3, jsLine: 1 });
    seedMappedScript({ scriptId: "s_w", url: "http://x/worker.js", source: "src/main.ts", sessionId: "SW1", tsLine: 3, jsLine: 1 });
    const r = parseOkEnvelope<{ candidates: any[] }>(await resolve.handler({ file: "src/main.ts", line: 3 }));
    const sessions = r.candidates.map((c) => c.session_id);
    expect(sessions).toEqual(expect.arrayContaining([null, "SW1"]));
  });
});

describe("registration metadata", () => {
  it("registers exactly the four source tools", () => {
    expect(Array.from(tools.keys()).sort()).toEqual([
      "get_script_source",
      "get_source",
      "list_scripts",
      "resolve_source_position",
    ]);
  });
});
