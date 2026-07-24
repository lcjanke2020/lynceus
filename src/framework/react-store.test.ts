import { describe, expect, it } from "vitest";
import {
  ReactComponentStore,
  ReactOperationsError,
  decodeReactOperations,
} from "./react-store.js";

// Payload layout is copied from the react-devtools-core@7.0.1 wire format
// captured by the S3 spike and pinned in docs/react-devtools-design.md §3.9.
// Values are intentionally literal at the operation boundary so a missing
// v7 operand (especially namePropStringID) breaks these fixtures visibly.
function initialTreePayload(): number[] {
  // string ids: 1=App, 2=Item, 3=a, 4=b, 5=Boundary
  const strings = [
    3, 65, 112, 112,
    4, 73, 116, 101, 109,
    1, 97,
    1, 98,
    8, 66, 111, 117, 110, 100, 97, 114, 121,
  ];
  return [
    1, 1, strings.length, ...strings,
    1, 1, 11, 0, 0, 1, 1,
    1, 2, 5, 1, 0, 1, 0, 0,
    1, 3, 5, 2, 2, 2, 3, 0,
    1, 4, 5, 2, 2, 2, 4, 0,
    3, 2, 2, 3, 4,
    4, 3, 1.25,
    5, 3, 1, 2,
    // All suspense opcodes are interleaved but structurally ignored.
    8, 100, 0, 5, 0, -1,
    9, 1, 100,
    10, 100, 0,
    11, 100, -1,
    12, 1, 100, 1, 0, 1, 5,
  ];
}

describe("React v7 operations decoder", () => {
  it("decodes strings, the fifth non-root ADD field, and every suspense opcode", () => {
    const decoded = decodeReactOperations(initialTreePayload());
    expect(decoded).toMatchObject({ rendererId: 1, rootId: 1 });
    expect(decoded.operations).toContainEqual({
      kind: "add-node",
      id: 3,
      type: 5,
      parentId: 2,
      ownerId: 2,
      displayName: "Item",
      key: "a",
      nameProp: null,
    });
    expect(decoded.operations.filter((operation) => operation.kind === "suspense")).toHaveLength(5);
  });

  it.each([
    [[1, 1], "header"],
    [[1, 0, 0], "root id"],
    [[1, 1, 2, 3], "string"],
    [[1, 1, 0, 1, 2, 5, 1], "operands"],
    [[1, 1, 0, 99], "Unsupported"],
    [[1, 1, 0, 11, 10, -2], "rectangle"],
  ])("rejects malformed payload %# without partial decoding", (payload, message) => {
    expect(() => decodeReactOperations(payload)).toThrowError(message);
  });
});

describe("ReactComponentStore", () => {
  it("materializes add/reorder/remove/root-removal batches atomically", () => {
    const store = new ReactComponentStore(7);
    store.apply(initialTreePayload(), 7);

    let snapshot = store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 100 });
    expect(snapshot.total_nodes).toBe(4);
    expect(snapshot.roots[0]?.children[0]).toMatchObject({
      component_id: 2,
      display_name: "App",
      children: [
        { component_id: 3, key: "a", errors: 1, warnings: 2 },
        { component_id: 4, key: "b" },
      ],
    });

    store.apply([1, 1, 0, 3, 2, 2, 4, 3], 7);
    expect(
      store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 100 }).roots[0]?.children[0]
        ?.children.map((child) => child.component_id),
    ).toEqual([4, 3]);

    store.apply([1, 1, 0, 2, 1, 3, 3, 2, 1, 4], 7);
    snapshot = store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 100 });
    expect(snapshot.total_nodes).toBe(3);
    expect(snapshot.roots[0]?.children[0]?.children.map((child) => child.component_id)).toEqual([4]);

    // v7 uses rootID=-1 for renderer-wide error/warning flushes outside a
    // commit. This is a valid batch, not a malformed root identifier.
    store.apply([1, -1, 0, 5, 4, 2, 3], 7);
    expect(
      store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 100 }).roots[0]
        ?.children[0]?.children[0],
    ).toMatchObject({ component_id: 4, errors: 2, warnings: 3 });

    const beforeMalformed = store.snapshot({
      maxDepth: 10,
      maxChildren: 10,
      maxNodes: 100,
    });
    // The ADD mutates the cloned tree before the invalid REORDER throws. This
    // distinguishes apply-then-swap atomicity from direct in-place mutation.
    expect(() =>
      store.apply(
        [1, 1, 0, 1, 5, 5, 2, 0, 0, 0, 0, 3, 2, 1, 999],
        7,
      ),
    ).toThrow(ReactOperationsError);
    expect(store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 100 })).toEqual(
      beforeMalformed,
    );

    store.apply([1, 1, 0, 6], 7);
    expect(store.size()).toBe(0);

    const removeBatchStore = new ReactComponentStore(7);
    removeBatchStore.apply(initialTreePayload(), 7);
    // The Fiber renderer currently represents a whole-root unmount as one
    // REMOVE list containing every descendant plus the root.
    removeBatchStore.apply([1, 1, 0, 2, 4, 3, 4, 2, 1], 7);
    expect(removeBatchStore.size()).toBe(0);
  });

  it("returns deterministic bounded snapshots and capped find results", () => {
    const store = new ReactComponentStore(2);
    store.apply(initialTreePayload(), 2);

    const snapshot = store.snapshot({ maxDepth: 1, maxChildren: 1, maxNodes: 2 });
    expect(snapshot).toMatchObject({
      generation: 2,
      total_nodes: 4,
      returned_nodes: 2,
      truncated: true,
      truncation_reasons: ["max_depth"],
    });
    expect(snapshot.roots[0]?.children[0]).toMatchObject({
      path: "root[1:1] > App[1:2]",
      truncated_children: 2,
      children: [],
    });

    const childCapped = store.snapshot({ maxDepth: 10, maxChildren: 1, maxNodes: 100 });
    expect(childCapped).toMatchObject({
      returned_nodes: 3,
      truncated: true,
      truncation_reasons: ["max_children"],
    });
    expect(childCapped.roots[0]?.children[0]).toMatchObject({
      truncated_children: 1,
      children: [{ component_id: 3 }],
    });

    const nodeCapped = store.snapshot({ maxDepth: 10, maxChildren: 10, maxNodes: 3 });
    expect(nodeCapped).toMatchObject({
      returned_nodes: 3,
      truncated: true,
      truncation_reasons: ["max_nodes"],
    });
    expect(nodeCapped.roots[0]?.children[0]).toMatchObject({
      truncated_children: 1,
      children: [{ component_id: 3 }],
    });

    const found = store.find({
      query: "item",
      exact: true,
      caseSensitive: false,
      limit: 1,
    });
    expect(found).toMatchObject({
      total_matches: 2,
      returned_matches: 1,
      truncated: true,
      matches: [
        {
          component_id: 3,
          renderer_id: 1,
          path: "root[1:1] > App[1:2] > Item[1:3]",
        },
      ],
    });
  });

  it("scopes state and renderer metadata to a document generation", () => {
    const store = new ReactComponentStore(0);
    store.apply(initialTreePayload(), 0);
    store.updateRendererMetadata({
      rendererId: 1,
      bundleType: 0,
      version: "18.3.1",
      rendererPackageName: "react-dom",
      supportsFiber: true,
    });
    expect(store.readWarnings()[0]?.code).toBe("production_build_detected");
    expect(store.unsupportedVersionMessage()).toBeNull();

    store.reset(1);
    expect(store.size()).toBe(0);
    expect(store.rendererMetadata()).toEqual([]);
    expect(() => store.apply(initialTreePayload(), 0)).toThrow(/generation/);

    store.updateRendererMetadata({
      rendererId: 1,
      bundleType: 1,
      version: "16.7.0",
      rendererPackageName: "react-dom",
      supportsFiber: true,
    });
    expect(store.unsupportedVersionMessage()).toContain("supports React 16.8–19");

    store.updateRendererMetadata({
      rendererId: 1,
      bundleType: 1,
      version: "16.8.0",
      rendererPackageName: "react-dom",
      supportsFiber: true,
    });
    expect(store.unsupportedVersionMessage()).toBeNull();
  });
});
