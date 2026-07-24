import { SourceMapGenerator } from "@jridgewell/source-map";
import { describe, expect, it, vi } from "vitest";
import { ScriptStore } from "../sourcemap/store.js";
import { resolveReactSource } from "./react-source.js";

function sourceMap(source: string, originalLine: number): string {
  const generator = new SourceMapGenerator({ file: "app.js" });
  generator.addMapping({
    generated: { line: 10, column: 19 },
    original: { line: originalLine, column: 2 },
    source,
  });
  return generator.toString();
}

function seed(
  store: ScriptStore,
  options: {
    scriptId: string;
    executionContextId: number;
    source: string;
    originalLine: number;
    sessionId?: string;
  },
): void {
  store.upsert({
    scriptId: options.scriptId,
    url: "http://localhost/assets/app.js",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    startLine: 0,
    startColumn: 0,
    endLine: 100,
    endColumn: 0,
    executionContextId: options.executionContextId,
    hash: options.scriptId,
  });
  store.attachMap(
    options.scriptId,
    options.sessionId,
    sourceMap(options.source, options.originalLine),
  );
}

describe("resolveReactSource", () => {
  it("uses execution-context and flat-session provenance for duplicate URLs", async () => {
    const store = new ScriptStore();
    seed(store, {
      scriptId: "root-script",
      executionContextId: 1,
      source: "src/Widget.tsx",
      originalLine: 4,
    });
    seed(store, {
      scriptId: "worker-script",
      sessionId: "worker-1",
      // Runtime execution-context ids are scoped to their CDP agent and can
      // collide. Flat-session provenance must disambiguate this from root.
      executionContextId: 1,
      source: "src/WorkerWidget.tsx",
      originalLine: 8,
    });

    await expect(
      resolveReactSource(
        store,
        ["Widget", "http://localhost/assets/app.js", 10, 20],
        1,
      ),
    ).resolves.toEqual({
      source: {
        file: "src/Widget.tsx",
        line: 4,
        column: 2,
        component_name: "Widget",
        generated: {
          url: "http://localhost/assets/app.js",
          line: 10,
          column: 20,
          script_id: "root-script",
          session_id: null,
        },
      },
      source_note: null,
    });

    const worker = await resolveReactSource(
      store,
      ["WorkerWidget", "http://localhost/assets/app.js", 10, 20],
      1,
      "worker-1",
    );
    expect(worker.source).toMatchObject({
      file: "src/WorkerWidget.tsx",
      line: 8,
      generated: { script_id: "worker-script", session_id: "worker-1" },
    });
  });

  it("returns null with useful notes for normal null, missing, and ambiguous sources", async () => {
    const store = new ScriptStore();
    expect((await resolveReactSource(store, null, 1)).source_note).toContain("normal");
    expect(
      (
        await resolveReactSource(
          store,
          ["Widget", "http://localhost/missing.js", 1, 1],
          1,
        )
      ).source_note,
    ).toContain("no parsed script");

    seed(store, {
      scriptId: "one",
      executionContextId: 1,
      source: "src/One.tsx",
      originalLine: 1,
    });
    seed(store, {
      scriptId: "two",
      executionContextId: 1,
      source: "src/Two.tsx",
      originalLine: 2,
    });
    const ambiguous = await resolveReactSource(
      store,
      ["Widget", "http://localhost/assets/app.js", 10, 20],
      1,
    );
    expect(ambiguous.source).toBeNull();
    expect(ambiguous.source_note).toContain("ambiguous");
  });

  it("does not wait on unrelated pending source maps", async () => {
    vi.useFakeTimers();
    try {
      const store = new ScriptStore();
      store.upsert({
        scriptId: "unrelated",
        url: "http://localhost/assets/unrelated.js",
        sourceMapURL: "unrelated.js.map",
        startLine: 0,
        startColumn: 0,
        endLine: 100,
        endColumn: 0,
        executionContextId: 1,
        hash: "unrelated",
      });
      store.upsert({
        scriptId: "target-without-map",
        url: "http://localhost/assets/plain.js",
        startLine: 0,
        startColumn: 0,
        endLine: 100,
        endColumn: 0,
        executionContextId: 1,
        hash: "plain",
      });

      const missing = resolveReactSource(
        store,
        ["Missing", "http://localhost/assets/missing.js", 1, 1],
        1,
      );
      const plain = resolveReactSource(
        store,
        ["Plain", "http://localhost/assets/plain.js", 1, 1],
        1,
      );

      // A store-wide pending-map gate would schedule a 25 ms poll for both
      // lookups and eventually consume the full 500 ms budget.
      expect(vi.getTimerCount()).toBe(0);
      await expect(missing).resolves.toMatchObject({
        source: null,
        source_note: expect.stringContaining("no parsed script"),
      });
      await expect(plain).resolves.toMatchObject({
        source: null,
        source_note: expect.stringContaining("no original TypeScript mapping"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
