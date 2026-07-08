import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
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
    sessionState.chromeHost = "127.0.0.1"; // loopback
    const r = await readOriginalSource(sessionState, "conditional-bp.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe("disk");
    // The real fixture source — proves we read the TS, not the compiled JS.
    expect(r.value.content).toContain("function processIteration");
    expect(r.value.content).toContain("i * 10");
  });

  it("refuses the disk read for a non-loopback session (no_content)", async () => {
    const jsUrl = pathToFileURL(
      join(REPO_ROOT, "examples/sample-node-app/dist/conditional-bp.js"),
    ).toString();
    seedMappedScript({
      scriptId: "s1",
      url: jsUrl,
      source: "../src/conditional-bp.ts",
      sourceMapURL: "conditional-bp.js.map",
    });
    sessionState.chromeHost = "10.1.2.3"; // NOT loopback → refuse file:// read
    const r = await readOriginalSource(sessionState, "conditional-bp.ts");
    expect(r).toEqual({ ok: false, reason: "no_content" });
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
