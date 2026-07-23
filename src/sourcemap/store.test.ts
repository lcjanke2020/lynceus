import { describe, it, expect } from "vitest";
import { SourceMapGenerator } from "@jridgewell/source-map";
import {
  ScriptStore,
  isLineMapped,
  mapCdpToOriginal,
  mapOriginalToGenerated,
  nearestMappedLines,
  waitForConsumer,
  cdpToPublic,
  publicToCdp,
} from "./store.js";

// Build a tiny synthetic source map for tests.
// Generated JS:
//   line 1: function add(a, b) { return a + b; }   (TS line 3: return a + b)
//   line 2: console.log(add(1, 2));                 (TS line 6: console.log call)
function buildMap(sourceName: string): string {
  const gen = new SourceMapGenerator({ file: "out.js" });
  gen.addMapping({
    generated: { line: 1, column: 22 },
    original: { line: 3, column: 2 },
    source: sourceName,
    name: "add",
  });
  gen.addMapping({
    generated: { line: 2, column: 0 },
    original: { line: 6, column: 0 },
    source: sourceName,
  });
  return gen.toString();
}

describe("CDP <-> public line numbering", () => {
  it("CDP 0-based ↔ public 1-based", () => {
    expect(cdpToPublic({ lineNumber: 0, columnNumber: 5 })).toEqual({ line: 1, column: 5 });
    expect(publicToCdp({ line: 1, column: 5 })).toEqual({ lineNumber: 0, columnNumber: 5 });
  });
});

describe("ScriptStore + bidirectional translation", () => {
  it("maps CDP frame -> original TS coord", () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h1",
    });
    store.attachMap("s1", undefined, buildMap("src/foo.ts"));
    // CDP location is 0-based; mapping says JS line 1 col 22 → TS line 3 col 2.
    const result = mapCdpToOriginal(store, { scriptId: "s1", lineNumber: 0, columnNumber: 22 }, undefined);
    expect(result).toEqual({ file: "src/foo.ts", line: 3, column: 2 });
  });

  it("maps TS coord -> all generated coords across scripts", async () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/a.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h1",
    });
    store.upsert({
      scriptId: "s2",
      url: "http://localhost/b.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h2",
    });
    store.attachMap("s1", undefined, buildMap("src/foo.ts"));
    store.attachMap("s2", undefined, buildMap("src/bar.ts"));

    const fooLocs = await mapOriginalToGenerated(store, "src/foo.ts", 3, 2);
    expect(fooLocs).toHaveLength(1);
    expect(fooLocs[0]).toMatchObject({
      scriptId: "s1",
      scriptUrl: "http://localhost/a.js",
      lineNumber: 0, // public 1 → CDP 0
      columnNumber: 22,
    });

    // bar.ts only matches s2.
    const barLocs = await mapOriginalToGenerated(store, "src/bar.ts", 6);
    expect(barLocs).toHaveLength(1);
    expect(barLocs[0]?.scriptId).toBe("s2");
  });

  it("finds scripts by source-path suffix match (webpack:/// prefix)", async () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/app.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h1",
    });
    // The map's source carries the messy prefix bundlers love.
    store.attachMap("s1", undefined, buildMap("webpack:///./src/foo.ts"));

    // User passes a clean suffix.
    const locs = await mapOriginalToGenerated(store, "src/foo.ts", 3, 2);
    expect(locs).toHaveLength(1);
    expect(locs[0]?.scriptId).toBe("s1");

    // Reverse direction normalizes the source on the way out.
    const reverse = mapCdpToOriginal(store, { scriptId: "s1", lineNumber: 0, columnNumber: 22 }, undefined);
    expect(reverse).toEqual({ file: "src/foo.ts", line: 3, column: 2 });
  });

  it("returns null for unmapped scripts and no candidates for unknown sources", async () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/x.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h1",
    });
    // No attachMap → no consumer.
    expect(mapCdpToOriginal(store, { scriptId: "s1", lineNumber: 0, columnNumber: 0 }, undefined)).toBeNull();
    expect(await mapOriginalToGenerated(store, "no/such/file.ts", 1)).toHaveLength(0);
  });

  it("compound key: same scriptId in two sessions does NOT collide", () => {
    // Codex PR#5 #2 regression: pre-fix, ScriptStore was keyed by scriptId
    // alone, so a worker emitting scriptId="42" would overwrite the root's
    // scriptId="42" — paused frames in the root then mapped through the
    // worker's source map.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "42", url: "http://localhost/root.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h-root",
    });
    store.upsert({
      scriptId: "42", url: "http://localhost/worker.js",
      sessionId: "SW1",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 2, hash: "h-worker",
    });
    store.attachMap("42", undefined, buildMap("src/main.ts"));
    store.attachMap("42", "SW1", buildMap("src/worker.ts"));

    // Root's "42" still maps to main.ts.
    const rootMap = mapCdpToOriginal(store, { scriptId: "42", lineNumber: 0, columnNumber: 22 }, undefined);
    expect(rootMap).toEqual({ file: "src/main.ts", line: 3, column: 2 });

    // Worker's "42" maps to worker.ts.
    const workerMap = mapCdpToOriginal(store, { scriptId: "42", lineNumber: 0, columnNumber: 22 }, "SW1");
    expect(workerMap).toEqual({ file: "src/worker.ts", line: 3, column: 2 });

    // get() resolves each independently.
    expect(store.get("42", undefined)?.url).toBe("http://localhost/root.js");
    expect(store.get("42", "SW1")?.url).toBe("http://localhost/worker.js");

    // remove only affects the targeted session.
    store.remove("42", "SW1");
    expect(store.get("42", "SW1")).toBeUndefined();
    expect(store.get("42", undefined)?.url).toBe("http://localhost/root.js");
  });

  it("indexes every script candidate by URL and maintains the index across updates", () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "42", url: "http://localhost/shared.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "root",
    });
    store.upsert({
      scriptId: "42", url: "http://localhost/shared.js", sessionId: "SW1",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 2, hash: "worker",
    });
    expect(store.findByUrl("http://localhost/shared.js")).toHaveLength(2);

    store.upsert({
      scriptId: "42", url: "http://localhost/renamed.js", sessionId: "SW1",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 2, hash: "worker-2",
    });
    expect(store.findByUrl("http://localhost/shared.js").map((script) => script.hash)).toEqual([
      "root",
    ]);
    expect(store.findByUrl("http://localhost/renamed.js")[0]?.hash).toBe("worker-2");

    store.remove("42", "SW1");
    expect(store.findByUrl("http://localhost/renamed.js")).toEqual([]);
    store.clear();
    expect(store.findByUrl("http://localhost/shared.js")).toEqual([]);
  });

  it("findByOriginalSource returns multiple candidates when several scripts map to the same TS file", () => {
    // Real-world: a TS file imported by multiple chunks (vendor.js + app.js)
    // produces two scripts whose source maps both reference src/util.ts.
    // set_breakpoint must bind in BOTH; findByOriginalSource must return both.
    const store = new ScriptStore();
    for (const [scriptId, url] of [
      ["s1", "http://localhost/vendor.js"],
      ["s2", "http://localhost/app.js"],
    ] as const) {
      store.upsert({
        scriptId, url,
        startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
        executionContextId: 1, hash: scriptId,
      });
      store.attachMap(scriptId, undefined, buildMap("src/util.ts"));
    }
    const matches = store.findByOriginalSource("src/util.ts");
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.scriptId))).toEqual(new Set(["s1", "s2"]));
  });

  it("mapOriginalToGenerated finds the line even when caller passes col 0 (regression: PR #11 e2e)", async () => {
    // The real bug: vite/esbuild emit source maps where the only mapping
    // on `return 2;` (handlers.ts:12) is at originalColumn 2 (the indent).
    // The earlier impl called generatedPositionFor({line:12, column:0})
    // which requires an EXACT column match and returned line:null → set_
    // breakpoint reported `no_mapping` for any TS line whose first mapping
    // wasn't at col 0. The fix uses allGeneratedPositionsFor which
    // enumerates every mapping on the source line. This synthetic map
    // mirrors the failing case: mapping at (line:3, col:2), no mapping at
    // (line:3, col:0).
    const gen = new SourceMapGenerator({ file: "out.js" });
    gen.addMapping({
      generated: { line: 1, column: 100 },
      original: { line: 3, column: 2 }, // indented statement, NOT col 0
      source: "src/handlers.ts",
    });
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h",
    });
    store.attachMap("s1", undefined, gen.toString());

    // Default column (0) — the failing case before the fix.
    const locs = await mapOriginalToGenerated(store, "src/handlers.ts", 3);
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({
      scriptId: "s1",
      lineNumber: 0, // CDP 0-based
      columnNumber: 100,
    });
  });

  it("mapOriginalToGenerated honors an explicitly-supplied column", async () => {
    // Codex/Opus PR #11 round-2: the column parameter was silently ignored
    // (hard-coded to 0 in the lookup), regressing the explicit-column
    // contract. With two mappings on the same source line at different
    // original columns, asking for column 0 returns the first mapping,
    // asking for column 8 returns the second.
    const gen = new SourceMapGenerator({ file: "out.js" });
    gen.addMapping({
      generated: { line: 1, column: 100 },
      original: { line: 3, column: 2 },
      source: "src/foo.ts",
    });
    gen.addMapping({
      generated: { line: 1, column: 200 },
      original: { line: 3, column: 8 },
      source: "src/foo.ts",
    });
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h",
    });
    store.attachMap("s1", undefined, gen.toString());

    // column 0 (default) → first mapping on the line.
    const broad = await mapOriginalToGenerated(store, "src/foo.ts", 3);
    expect(broad).toHaveLength(1);
    expect(broad[0]?.columnNumber).toBe(100);

    // explicit column 8 → the mapping at that original column.
    const precise = await mapOriginalToGenerated(store, "src/foo.ts", 3, 8);
    expect(precise).toHaveLength(1);
    expect(precise[0]?.columnNumber).toBe(200);
  });

  it("mapOriginalToGenerated de-dups when multiple originalColumns collapse to one generated position", async () => {
    // After heavy minification, multiple originalColumn entries on the
    // same source line can compress to the same (genLine, genCol) — we
    // want exactly one breakpoint binding per distinct generated location.
    const gen = new SourceMapGenerator({ file: "out.js" });
    gen.addMapping({
      generated: { line: 1, column: 100 },
      original: { line: 3, column: 2 },
      source: "src/foo.ts",
    });
    gen.addMapping({
      generated: { line: 1, column: 100 }, // SAME generated position
      original: { line: 3, column: 9 }, // different original column
      source: "src/foo.ts",
    });
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      startLine: 0,
      startColumn: 0,
      endLine: 100,
      endColumn: 0,
      executionContextId: 1,
      hash: "h",
    });
    store.attachMap("s1", undefined, gen.toString());
    const locs = await mapOriginalToGenerated(store, "src/foo.ts", 3);
    expect(locs).toHaveLength(1);
  });

  it("findByOriginalSource skips scripts with no sources field (map never attached)", () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1", url: "http://localhost/x.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    // Deliberately don't call attachMap — `sources` stays undefined.
    expect(store.findByOriginalSource("src/anything.ts")).toEqual([]);
  });

  it("clear() destroys every consumer (releases SourceMapConsumer Wasm memory)", () => {
    // SourceMapConsumer holds Wasm-allocated memory that must be explicitly
    // freed via .destroy(). On `close_session` and `switchTarget`, every
    // consumer in the store must be destroyed or memory leaks accumulate
    // across reconnects.
    const store = new ScriptStore();
    let destroyed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `s${i}`;
      store.upsert({
        scriptId: id, url: `http://localhost/${id}.js`,
        startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
        executionContextId: 1, hash: id,
      });
      store.attachMap(id, undefined, buildMap(`src/${id}.ts`));
      // Wrap each consumer's destroy with a spy.
      const script = store.get(id, undefined)!;
      const realDestroy = script.consumer!.destroy.bind(script.consumer);
      script.consumer!.destroy = () => {
        destroyed.push(id);
        realDestroy();
      };
    }
    store.clear();
    expect(destroyed.sort()).toEqual(["s0", "s1", "s2"]);
    // And the store is empty afterwards.
    expect(store.all()).toEqual([]);
  });

  it("clear() is safe when entries have no consumer", () => {
    // Some scripts arrive without a sourceMapURL → no consumer is attached.
    // clear() must not crash on `s.consumer?.destroy()` for these.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "no-map", url: "http://localhost/raw.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    expect(() => store.clear()).not.toThrow();
    expect(store.all()).toEqual([]);
  });

  it("mapOriginalToGenerated waits for an in-flight source map (entry-pause race)", async () => {
    // Race: Debugger.scriptParsed lands the script synchronously, but
    // loadSourceMap is fire-and-forget. An immediate set_breakpoint after
    // the entry pause returns can hit no_mapping a few ms before the map
    // parses. On the browser side this is masked by navigate(wait:"load")
    // blocking past map loads; on Node, attach_node's entry pause has no
    // such barrier. mapOriginalToGenerated should poll briefly when a
    // pending sourceMapURL exists and resolve once attachMap completes.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      sourceMapURL: "out.js.map", // signals "map load in flight"
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    expect(store.hasPendingMaps()).toBe(true);

    // Kick off the lookup BEFORE attaching the map.
    const lookup = mapOriginalToGenerated(store, "src/foo.ts", 3, 2);

    // Attach the map mid-wait (50 ms in, well under the 500 ms cap).
    await new Promise((r) => setTimeout(r, 50));
    store.attachMap("s1", undefined, buildMap("src/foo.ts"));

    const locs = await lookup;
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ scriptId: "s1", lineNumber: 0, columnNumber: 22 });
  });

  it("mapOriginalToGenerated returns empty once every pending map has settled (no-match case)", async () => {
    // Symmetric corner: a script has a pending map, but when it loads the
    // map doesn't reference the file we asked for. The poll loop should
    // give up at the hasPendingMaps()==false check, not hold the caller
    // for the full 500 ms.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      sourceMapURL: "out.js.map",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });

    const t0 = Date.now();
    const lookup = mapOriginalToGenerated(store, "src/missing.ts", 1);
    // Resolve the map fast — to something that DOESN'T match src/missing.ts.
    await new Promise((r) => setTimeout(r, 30));
    store.attachMap("s1", undefined, buildMap("src/other.ts"));

    const locs = await lookup;
    expect(locs).toEqual([]);
    // Loose upper bound — give up promptly, not after the full 500 ms cap.
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("HMR upsert: re-parsed script preserves consumer when no map is re-attached", () => {
    // Documents the behavior the new src/sourcemap/store.ts comment calls
    // out: upsert's Object.assign does NOT clear consumer/sources because
    // they're Omit<>'d from the input type. After a soft reload (same
    // sessionId+scriptId), the script still has its old map until
    // attachMap() is called again. This is intentional for soft reloads
    // but means HMR-changed maps leak — surface the behavior in a test
    // so anyone tempted to "fix" it sees the regression risk.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1", url: "http://localhost/app.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h-v1",
    });
    store.attachMap("s1", undefined, buildMap("src/main.ts"));
    expect(store.get("s1", undefined)?.consumer).toBeDefined();
    expect(store.get("s1", undefined)?.sources).toEqual(["src/main.ts"]);

    // Simulate HMR re-parse: same scriptId, new hash, no attachMap follow-up.
    store.upsert({
      scriptId: "s1", url: "http://localhost/app.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h-v2",
    });
    const after = store.get("s1", undefined)!;
    // Hash updated.
    expect(after.hash).toBe("h-v2");
    // BUT consumer + sources survived — the documented HMR leak.
    expect(after.consumer).toBeDefined();
    expect(after.sources).toEqual(["src/main.ts"]);
  });
});

describe("waitForConsumer (source-map wait race 2 primitive)", () => {
  // Direct contract tests for the helper that both mapOriginalToGenerated
  // (set_breakpoint path) and formatFrameForPause (pause-frame path) rely
  // on. Three exit conditions: predicate true, no maps in flight,
  // deadline expired. Upstream review.

  it("returns immediately when the predicate is already true", async () => {
    // Caller checks predicate via store state synchronously, but if the
    // condition is already met, waitForConsumer must not even schedule
    // its first timer.
    const store = new ScriptStore();
    const t0 = Date.now();
    await waitForConsumer(store, () => true, Date.now() + 500);
    expect(Date.now() - t0).toBeLessThan(10);
  });

  it("returns immediately when no source maps are pending (nothing to wait on)", async () => {
    // Empty store: hasPendingMaps()==false. waitForConsumer should give
    // up before its first poll tick rather than burning the full deadline.
    const store = new ScriptStore();
    const t0 = Date.now();
    await waitForConsumer(store, () => false, Date.now() + 500);
    expect(Date.now() - t0).toBeLessThan(10);
  });

  it("polls until predicate becomes true (consumer attaches mid-wait)", async () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      sourceMapURL: "out.js.map",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    expect(store.hasPendingMaps()).toBe(true);
    expect(store.get("s1")?.consumer).toBeUndefined();

    const lookup = waitForConsumer(
      store,
      () => store.get("s1")?.consumer != null,
      Date.now() + 500,
    );

    // Attach mid-wait. The next poll tick (≤25 ms later) flips the predicate.
    setTimeout(() => store.attachMap("s1", undefined, buildMap("src/foo.ts")), 30);
    await lookup;
    expect(store.get("s1")?.consumer).toBeDefined();
  });

  it("gives up at the deadline rather than hanging when predicate never trips", async () => {
    // Pending map that never settles AND a predicate that's never true:
    // the deadline must bound the wait. Use a short deadline (50 ms) so
    // the test doesn't spend the full production 500 ms cap.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      sourceMapURL: "out.js.map",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    expect(store.hasPendingMaps()).toBe(true);

    const t0 = Date.now();
    await waitForConsumer(store, () => false, Date.now() + 50);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(150);
  });

  it("exits early when hasPendingMaps() flips false (load settled but no match)", async () => {
    // The "global no-pending" early-exit path. Predicate is never true
    // (we're waiting for a consumer on a script that doesn't exist),
    // but once the in-flight map settles via attachMap, hasPendingMaps
    // returns false and waitForConsumer bails immediately rather than
    // waiting out the full deadline.
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1",
      url: "http://localhost/out.js",
      sourceMapURL: "out.js.map",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h",
    });
    const t0 = Date.now();
    const wait = waitForConsumer(
      store,
      () => store.get("s99")?.consumer != null, // never trips
      Date.now() + 500,
    );
    setTimeout(() => store.attachMap("s1", undefined, buildMap("src/other.ts")), 30);
    await wait;
    // Way under the 500 ms cap — proves the hasPendingMaps short-circuit fired.
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe("allOriginalSources (no_mapping path echo, GH #37)", () => {
  const seed = (store: ScriptStore, scriptId: string, url: string) => {
    store.upsert({
      scriptId, url,
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: `h-${scriptId}`,
    });
  };

  it("dedups across scripts, insertion order, normalized paths", () => {
    const store = new ScriptStore();
    seed(store, "s1", "http://x/a.js");
    seed(store, "s2", "http://x/b.js");
    // s1 and s2 both reference src/foo.ts; the webpack prefix must fold away.
    store.attachMap("s1", undefined, buildMap("webpack:///./src/foo.ts"));
    store.attachMap("s2", undefined, buildMap("src/foo.ts"));
    const gen = new SourceMapGenerator({ file: "b.js" });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "src/bar.ts" });
    gen.addMapping({ generated: { line: 2, column: 0 }, original: { line: 1, column: 0 }, source: "src/foo.ts" });
    seed(store, "s3", "http://x/c.js");
    store.attachMap("s3", undefined, gen.toString());
    expect(store.allOriginalSources()).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("skips scripts whose map never attached (mapped-only projection)", () => {
    const store = new ScriptStore();
    seed(store, "s1", "http://x/a.js");
    seed(store, "s2", "http://x/b.js");
    store.attachMap("s2", undefined, buildMap("src/real.ts"));
    expect(store.allOriginalSources()).toEqual(["src/real.ts"]);
  });

  it("empty store -> []", () => {
    expect(new ScriptStore().allOriginalSources()).toEqual([]);
  });
});

describe("nearestMappedLines (no_mapping line hint, GH #37)", () => {
  // Map with original lines 14 and 16 only — line 15 is the unmapped gap.
  const gappedStore = () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1", url: "http://x/a.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h1",
    });
    const gen = new SourceMapGenerator({ file: "a.js" });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 14, column: 0 }, source: "src/foo.ts" });
    gen.addMapping({ generated: { line: 2, column: 0 }, original: { line: 16, column: 0 }, source: "src/foo.ts" });
    store.attachMap("s1", undefined, gen.toString());
    return store;
  };

  it("returns both neighbors, ascending, when below and above are equidistant", () => {
    expect(nearestMappedLines(gappedStore(), "src/foo.ts", 15)).toEqual([14, 16]);
  });

  it("returns only the genuinely nearest line, not everything in range", () => {
    // From 17: line 16 is at distance 1; 14 (distance 3) must NOT appear.
    expect(nearestMappedLines(gappedStore(), "src/foo.ts", 17)).toEqual([16]);
  });

  it("suffix-matched file names work (same pathMatches fold as set_breakpoint)", () => {
    expect(nearestMappedLines(gappedStore(), "foo.ts", 15)).toEqual([14, 16]);
  });

  it("never probes below line 1", () => {
    // From line 1, the nearest hit requires d=13; the negative probes on the
    // way must be skipped rather than passed to the consumer.
    expect(nearestMappedLines(gappedStore(), "src/foo.ts", 1)).toEqual([14]);
  });

  it("[] when nothing maps within the radius", () => {
    expect(nearestMappedLines(gappedStore(), "src/foo.ts", 90, 25)).toEqual([]);
  });

  it("[] for a file no loaded map references", () => {
    expect(nearestMappedLines(gappedStore(), "src/other.ts", 15)).toEqual([]);
  });

  it("scans across every matching script, not just the first", () => {
    const store = gappedStore();
    // Second script maps the SAME file at line 18 — from line 17 the nearest
    // hits are 16 (script 1) and 18 (script 2), both at distance 1.
    store.upsert({
      scriptId: "s2", url: "http://x/b.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h2",
    });
    const gen = new SourceMapGenerator({ file: "b.js" });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 18, column: 0 }, source: "src/foo.ts" });
    store.attachMap("s2", undefined, gen.toString());
    expect(nearestMappedLines(store, "src/foo.ts", 17)).toEqual([16, 18]);
  });
});

describe("isLineMapped (no_mapping column/race disambiguation, PR #59)", () => {
  it("true for a mapped line regardless of where its columns start, false for the gap and unknown files", () => {
    const store = new ScriptStore();
    store.upsert({
      scriptId: "s1", url: "http://x/a.js",
      startLine: 0, startColumn: 0, endLine: 100, endColumn: 0,
      executionContextId: 1, hash: "h1",
    });
    // PR #11 sample shape: line 12 maps at columns 2 and 9 only — never 0.
    const gen = new SourceMapGenerator({ file: "a.js" });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 12, column: 2 }, source: "src/foo.ts" });
    gen.addMapping({ generated: { line: 1, column: 30 }, original: { line: 12, column: 9 }, source: "src/foo.ts" });
    store.attachMap("s1", undefined, gen.toString());
    expect(isLineMapped(store, "src/foo.ts", 12)).toBe(true);
    expect(isLineMapped(store, "src/foo.ts", 13)).toBe(false);
    expect(isLineMapped(store, "src/other.ts", 12)).toBe(false);
  });
});
