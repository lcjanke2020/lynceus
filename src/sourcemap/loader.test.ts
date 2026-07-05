import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SourceMapGenerator } from "@jridgewell/source-map";
import { buildScriptParsedHandler, decodeDataUri } from "./loader.js";
import { ScriptStore } from "./store.js";
import type { Session } from "../session/state.js";

describe("decodeDataUri", () => {
  it("decodes base64 with single content-type parameter (typical CDP shape)", () => {
    const json = '{"version":3}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    expect(decodeDataUri(`data:application/json;base64,${b64}`)).toBe(json);
  });

  it("decodes base64 with extra parameters (webpack inline-source-map shape)", () => {
    // Regression for the regex bug — `;charset=utf-8;base64,` previously
    // failed to match because `[^,;]*` refused to consume `;`, and `;base64`
    // had to be the *only* parameter.
    const json = '{"version":3,"sources":["src/foo.ts"]}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    expect(decodeDataUri(`data:application/json;charset=utf-8;base64,${b64}`)).toBe(json);
  });

  it("decodes parameter order variants", () => {
    const json = '{"x":1}';
    const b64 = Buffer.from(json, "utf8").toString("base64");
    // `base64` parameter not necessarily last among params
    expect(decodeDataUri(`data:application/json;base64;charset=utf-8,${b64}`)).toBe(json);
  });

  it("decodes URL-encoded (non-base64) payloads", () => {
    expect(decodeDataUri("data:text/plain,hello%20world")).toBe("hello world");
  });

  it("throws on non-data URIs and malformed inputs", () => {
    expect(() => decodeDataUri("http://example.com")).toThrow(/Not a data URI/);
    expect(() => decodeDataUri("data:no-comma-here")).toThrow(/no comma/);
    expect(() => decodeDataUri("data:application/json;base64,")).toThrow(/Empty/);
  });
});

// Node-kind sessions can't go through Network.loadNetworkResource (the domain
// doesn't exist in Node Inspector), so the loader reads file:// source maps
// from disk. These tests pin the resolution + read against a real on-disk
// fixture — small enough to do without mocks.
describe("buildScriptParsedHandler — node tier", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "leo100-loader-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // Minimal session shape — only the fields the handler + loopback gate
  // touch. `client` stays null because the node path never reads it.
  function nodeSession(host: string | null = "127.0.0.1"): Session {
    return {
      kind: "node",
      client: null,
      scripts: new ScriptStore(),
      chromeHost: host,
    } as unknown as Session;
  }

  // loadSourceMap is fire-and-forget inside the handler (`void
  // loadSourceMap(...)`). Poll until attachMap or setLoadError lands.
  async function waitForMapState(
    scripts: ScriptStore,
    scriptId: string,
    timeoutMs = 1000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = scripts.get(scriptId);
      if (e && (e.consumer || e.loadError)) return e;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for source-map state on ${scriptId}`);
  }

  it("loads a file:// source map from disk via fs.readFile + fileURLToPath", async () => {
    // Build a real source map for handlers.ts:7 → handlers.js:1
    const gen = new SourceMapGenerator({ file: "handlers.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 7, column: 0 },
      source: "src/handlers.ts",
    });
    const scriptPath = path.join(tmp, "handlers.js");
    const mapPath = path.join(tmp, "handlers.js.map");
    await writeFile(scriptPath, `// dummy\n`);
    await writeFile(mapPath, gen.toString());

    const s = nodeSession();
    const handler = buildScriptParsedHandler(s, undefined);
    // Mirror what node --inspect-brk emits (see probe in /tmp/leo100-probe):
    //   url        = file:///abs/path/handlers.js
    //   sourceMapURL = handlers.js.map  (relative)
    handler(
      {
        scriptId: "42",
        url: pathToFileURL(scriptPath).toString(),
        sourceMapURL: "handlers.js.map",
        startLine: 0,
        startColumn: 0,
        endLine: 10,
        endColumn: 0,
        executionContextId: 1,
        hash: "abc",
        isModule: true,
      },
      undefined,
    );

    const entry = await waitForMapState(s.scripts, "42");
    expect(entry.loadError).toBeUndefined();
    expect(entry.consumer).toBeDefined();
    // The map's `sources` reaches normalize.ts and lands as a stable path key.
    expect(entry.sources?.some((src) => src.endsWith("src/handlers.ts"))).toBe(true);
  });

  it("records a clear loadError when the file:// source map is missing", async () => {
    const s = nodeSession();
    const handler = buildScriptParsedHandler(s, undefined);
    const scriptPath = path.join(tmp, "missing.js"); // never written
    handler(
      {
        scriptId: "missing",
        url: pathToFileURL(scriptPath).toString(),
        sourceMapURL: "missing.js.map",
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        executionContextId: 1,
        hash: "z",
        isModule: true,
      },
      undefined,
    );

    const entry = await waitForMapState(s.scripts, "missing");
    expect(entry.consumer).toBeUndefined();
    expect(entry.loadError).toMatch(/ENOENT|no such file/);
  });

  it.each([
    ["explicit 127.0.0.1", "127.0.0.1"],
    ["IPv6 ::1", "::1"],
    ["hostname localhost", "localhost"],
    ["null (default-to-localhost)", null],
  ])("allows file:// reads when chromeHost is loopback (%s)", async (_label, host) => {
    const gen = new SourceMapGenerator({ file: "ok.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "src/ok.ts",
    });
    const scriptPath = path.join(tmp, "ok.js");
    await writeFile(scriptPath, `// ok\n`);
    await writeFile(path.join(tmp, "ok.js.map"), gen.toString());

    const s = nodeSession(host);
    const handler = buildScriptParsedHandler(s, undefined);
    handler(
      {
        scriptId: "ok",
        url: pathToFileURL(scriptPath).toString(),
        sourceMapURL: "ok.js.map",
        startLine: 0,
        startColumn: 0,
        endLine: 1,
        endColumn: 0,
        executionContextId: 1,
        hash: "ok",
        isModule: true,
      },
      undefined,
    );

    const entry = await waitForMapState(s.scripts, "ok");
    expect(entry.loadError).toBeUndefined();
    expect(entry.consumer).toBeDefined();
  });

  it("refuses file:// reads when chromeHost is non-loopback (security gate)", async () => {
    // Without this gate a remote attach_node could trick the loader into
    // reading attacker-chosen local paths. Upstream Copilot review.
    // Put a real file at /etc/hostname (or anywhere we know exists) to make
    // the test prove the refusal isn't just an ENOENT — the read must be
    // skipped, not fail.
    const remoteScript = "file:///etc/hostname";
    const s = nodeSession("203.0.113.42"); // TEST-NET-3 reserved range

    const handler = buildScriptParsedHandler(s, undefined);
    handler(
      {
        scriptId: "remote",
        url: remoteScript,
        sourceMapURL: "hostname.map",
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        executionContextId: 1,
        hash: "r",
        isModule: true,
      },
      undefined,
    );

    const entry = await waitForMapState(s.scripts, "remote");
    expect(entry.consumer).toBeUndefined();
    expect(entry.loadError).toMatch(/remote Node session|Refusing to read file:\/\//i);
    expect(entry.loadError).toContain("203.0.113.42");
  });

  it("passes data: source maps through decodeDataUri unchanged on node-kind", async () => {
    const gen = new SourceMapGenerator({ file: "inline.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 3, column: 0 },
      source: "src/inline.ts",
    });
    const b64 = Buffer.from(gen.toString(), "utf8").toString("base64");
    const dataUri = `data:application/json;base64,${b64}`;

    const s = nodeSession();
    const handler = buildScriptParsedHandler(s, undefined);
    handler(
      {
        scriptId: "inline",
        url: "file:///doesnt/need/to/exist.js", // data: path doesn't touch disk
        sourceMapURL: dataUri,
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        executionContextId: 1,
        hash: "i",
        isModule: true,
      },
      undefined,
    );

    const entry = await waitForMapState(s.scripts, "inline");
    expect(entry.loadError).toBeUndefined();
    expect(entry.consumer).toBeDefined();
    expect(entry.sources?.some((src) => src.endsWith("src/inline.ts"))).toBe(true);
  });
});
