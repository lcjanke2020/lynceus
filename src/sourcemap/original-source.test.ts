import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { SourceMapGenerator } from "@jridgewell/source-map";
import { sessionState } from "../session/state.js";
import { seedMappedScript } from "../../test/helpers/source-maps.js";
import { readOriginalSource } from "./original-source.js";

// repo root: this file is src/sourcemap/original-source.test.ts
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => sessionState.reset());

describe("readOriginalSource", () => {
  it("returns embedded sourcesContent (origin=source_map, no I/O)", async () => {
    seedMappedScript({
      scriptId: "s1",
      url: "http://x/app.js",
      source: "src/foo.ts",
      sourceContent: "const a = 1;\nconst b = 2;\n",
    });
    const r = await readOriginalSource(sessionState, "src/foo.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe("source_map");
    expect(r.value.content).toBe("const a = 1;\nconst b = 2;\n");
    expect(r.value.file).toBe("src/foo.ts");
    expect(r.value.scriptId).toBe("s1");
    expect(r.value.sessionId).toBeNull();
  });

  it("no_match when no script's map references the file", async () => {
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts", sourceContent: "x" });
    const r = await readOriginalSource(sessionState, "src/never.ts");
    expect(r).toEqual({ ok: false, reason: "no_match" });
  });

  it("no_content when the map references the file but has neither sourcesContent nor a readable file", async () => {
    // http-served script, no sourcesContent → nothing to read from disk.
    seedMappedScript({ scriptId: "s1", url: "http://x/app.js", source: "src/foo.ts" });
    const r = await readOriginalSource(sessionState, "src/foo.ts");
    expect(r).toEqual({ ok: false, reason: "no_content" });
  });

  it("reads the original .ts from disk when the map has no sourcesContent (origin=disk, loopback)", async () => {
    const jsUrl = pathToFileURL(
      join(REPO_ROOT, "examples/sample-node-app/dist/conditional-bp.js"),
    ).toString();
    seedMappedScript({
      scriptId: "s1",
      url: jsUrl,
      source: "../src/conditional-bp.ts",
      sourceMapURL: "conditional-bp.js.map",
      // no sourceContent → forces the disk fallback
    });
    sessionState.kind = "node";
    sessionState.chromeHost = "127.0.0.1"; // loopback
    const r = await readOriginalSource(sessionState, "conditional-bp.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe("disk");
    // The real fixture source — proves we read the TS, not the compiled JS.
    expect(r.value.content).toContain("function processIteration");
    expect(r.value.content).toContain("i * 10");
  });

  it("refuses the disk read for a non-loopback Node session (no_content)", async () => {
    const jsUrl = pathToFileURL(
      join(REPO_ROOT, "examples/sample-node-app/dist/conditional-bp.js"),
    ).toString();
    seedMappedScript({
      scriptId: "s1",
      url: jsUrl,
      source: "../src/conditional-bp.ts",
      sourceMapURL: "conditional-bp.js.map",
    });
    sessionState.kind = "node";
    sessionState.chromeHost = "10.1.2.3"; // NOT loopback → refuse file:// read
    const r = await readOriginalSource(sessionState, "conditional-bp.ts");
    expect(r).toEqual({ ok: false, reason: "no_content" });
  });

  it("SECURITY: never reads disk for a browser session, even loopback (untrusted map cannot exfiltrate local files)", async () => {
    // A browser page + its source maps are (potentially untrusted) HTTP
    // content; a malicious map could advertise a file:// source pointing at an
    // arbitrary local file. The disk fallback is Node-only, so this must return
    // no_content, NOT the file bytes. (codex + Copilot review, GH #46 PR.)
    const jsUrl = pathToFileURL(
      join(REPO_ROOT, "examples/sample-node-app/dist/conditional-bp.js"),
    ).toString();
    seedMappedScript({
      scriptId: "s1",
      url: jsUrl,
      source: "../src/conditional-bp.ts",
      sourceMapURL: "conditional-bp.js.map",
    });
    sessionState.kind = "browser"; // the vulnerable case
    sessionState.chromeHost = "127.0.0.1"; // loopback — the disk read would otherwise fire
    const r = await readOriginalSource(sessionState, "conditional-bp.ts");
    expect(r).toEqual({ ok: false, reason: "no_content" });
  });

  it("waits for the TARGET session's map even when another session already has the file loaded (codex round-2)", async () => {
    // A worker copy of src/main.ts is ALREADY loaded...
    seedMappedScript({
      scriptId: "s_w",
      url: "http://x/worker.js",
      source: "src/main.ts",
      sessionId: "SW1",
      sourceContent: "WORKER",
    });
    // ...while the ROOT copy's map is still in flight (sourceMapURL set, no
    // consumer yet → hasPendingMaps() is true, so waitForConsumer polls).
    sessionState.scripts.upsert({
      scriptId: "s_root",
      url: "http://x/main.js",
      sourceMapURL: "http://x/main.js.map",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h-root",
    });
    // Root map attaches partway through the bounded wait.
    setTimeout(() => {
      const gen = new SourceMapGenerator({ file: "http://x/main.js" });
      gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "src/main.ts" });
      gen.setSourceContent("src/main.ts", "ROOT");
      sessionState.scripts.attachMap("s_root", undefined, gen.toString());
    }, 50);
    // Pre-fix: the unfiltered wait predicate saw the worker map and returned
    // immediately, so the root filter found nothing → no_match. Post-fix the
    // wait is root-scoped, so it waits for the root map and returns ROOT.
    const r = await readOriginalSource(sessionState, "src/main.ts", null);
    expect(r.ok && r.value.content).toBe("ROOT");
  });

  it("session_id disambiguates a worker copy from the root", async () => {
    seedMappedScript({ scriptId: "s_root", url: "http://x/main.js", source: "src/main.ts", sourceContent: "ROOT" });
    seedMappedScript({
      scriptId: "s_w",
      url: "http://x/worker.js",
      source: "src/main.ts",
      sessionId: "SW1",
      sourceContent: "WORKER",
    });
    const root = await readOriginalSource(sessionState, "src/main.ts", null);
    const worker = await readOriginalSource(sessionState, "src/main.ts", "SW1");
    expect(root.ok && root.value.content).toBe("ROOT");
    expect(worker.ok && worker.value.content).toBe("WORKER");
  });
});
