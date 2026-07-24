/**
 * Materialized React component tree for the react-devtools-core bridge.
 *
 * The decoder follows the immutable react-devtools-core@7.0.1 operations
 * protocol documented in docs/react-devtools-design.md §3.9. The transport-
 * neutral decoder/store split is also informed by skylarbarrera's MIT-licensed
 * react-devtools-mcp bridge (https://github.com/skylarbarrera/react-devtools-mcp).
 * This implementation is intentionally local and bounds-checks every operand
 * before applying a complete batch atomically.
 */

export class ReactOperationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReactOperationsError";
  }
}

export interface ReactRendererMetadata {
  rendererId: number;
  bundleType: number | null;
  version: string | null;
  rendererPackageName: string | null;
  supportsFiber: boolean | null;
}

export interface ReactRendererSnapshot {
  renderer_id: number;
  bundle_type: number | null;
  renderer_version: string | null;
  renderer_package_name: string | null;
  supports_fiber: boolean | null;
}

export function toReactRendererSnapshot(
  metadata: ReactRendererMetadata,
): ReactRendererSnapshot {
  return {
    renderer_id: metadata.rendererId,
    bundle_type: metadata.bundleType,
    renderer_version: metadata.version,
    renderer_package_name: metadata.rendererPackageName,
    supports_fiber: metadata.supportsFiber,
  };
}

export interface ReactComponentRecord {
  id: number;
  rendererId: number;
  rootId: number;
  type: number;
  parentId: number | null;
  ownerId: number | null;
  displayName: string | null;
  key: string | null;
  nameProp: string | null;
  children: number[];
  treeBaseDuration: number | null;
  errors: number;
  warnings: number;
  subtreeMode: number | null;
}

interface AddRootOperation {
  kind: "add-root";
  id: number;
  type: number;
}

interface AddNodeOperation {
  kind: "add-node";
  id: number;
  type: number;
  parentId: number;
  ownerId: number;
  displayName: string | null;
  key: string | null;
  nameProp: string | null;
}

type DecodedOperation =
  | AddRootOperation
  | AddNodeOperation
  | { kind: "remove"; ids: number[] }
  | { kind: "reorder"; id: number; children: number[] }
  | { kind: "duration"; id: number; duration: number }
  | { kind: "errors"; id: number; errors: number; warnings: number }
  | { kind: "remove-root" }
  | { kind: "subtree-mode"; id: number; mode: number }
  | { kind: "suspense" };

export interface DecodedReactOperations {
  rendererId: number;
  rootId: number;
  operations: DecodedOperation[];
}

const ELEMENT_TYPE_ROOT = 11;
const MAX_OPERATIONS_VALUES = 1_000_000;
const MAX_STRING_CODE_POINTS = 100_000;
const STRING_DECODE_CHUNK = 8_192;

const ELEMENT_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "class",
  2: "context",
  5: "function",
  6: "forward_ref",
  7: "host",
  8: "memo",
  9: "other",
  10: "profiler",
  11: "root",
  12: "suspense",
  13: "suspense_list",
  14: "tracing_marker",
  15: "virtual",
  16: "view_transition",
  17: "activity",
});

export function reactElementTypeName(type: number): string {
  return ELEMENT_TYPE_NAMES[type] ?? `unknown_${type}`;
}

function fail(message: string, offset?: number): never {
  throw new ReactOperationsError(
    offset === undefined ? message : `${message} at operations offset ${offset}`,
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Decode one complete v7 operations batch without mutating session state. */
export function decodeReactOperations(payload: unknown): DecodedReactOperations {
  if (!Array.isArray(payload)) fail("React operations payload must be an array");
  if (payload.length < 3) fail("React operations payload is missing its three-value header");
  if (payload.length > MAX_OPERATIONS_VALUES) {
    fail(`React operations payload exceeds ${MAX_OPERATIONS_VALUES} numeric values`);
  }
  for (let index = 0; index < payload.length; index += 1) {
    if (typeof payload[index] !== "number" || !Number.isFinite(payload[index])) {
      fail("React operations payload contains a non-finite number", index);
    }
  }

  const values = payload as number[];
  const rendererId = readPositiveInteger(values, 0, "renderer id");
  const rootId = readInteger(values, 1, "root id");
  // react-devtools-core uses -1 for renderer-wide batches that are not
  // associated with a commit root (notably brute-force error/warning
  // flushes). Mount/reorder/unmount batches continue to carry a positive id.
  if (rootId !== -1 && rootId <= 0) {
    fail("root id must be -1 or positive", 1);
  }
  const stringTableSize = readNonNegativeInteger(values, 2, "string-table size");
  const stringTableEnd = 3 + stringTableSize;
  if (stringTableEnd > values.length) {
    fail("React operations string table exceeds the payload", 2);
  }

  const strings: Array<string | null> = [null];
  let offset = 3;
  while (offset < stringTableEnd) {
    const length = readNonNegativeInteger(values, offset, "string length");
    offset += 1;
    if (length > MAX_STRING_CODE_POINTS) {
      fail(`React operations string exceeds ${MAX_STRING_CODE_POINTS} code points`, offset - 1);
    }
    if (offset + length > stringTableEnd) {
      fail("React operations string exceeds the declared string-table size", offset - 1);
    }
    const codePoints: number[] = [];
    for (let index = 0; index < length; index += 1) {
      const codePointOffset = offset + index;
      const codePoint = readNonNegativeInteger(values, codePointOffset, "string code point");
      if (codePoint > 0x10ffff) fail("React operations string code point is out of range", codePointOffset);
      codePoints.push(codePoint);
    }
    try {
      let decoded = "";
      for (let start = 0; start < codePoints.length; start += STRING_DECODE_CHUNK) {
        decoded += String.fromCodePoint(
          ...codePoints.slice(start, start + STRING_DECODE_CHUNK),
        );
      }
      strings.push(decoded);
    } catch {
      fail("React operations string table contains an invalid code point", offset);
    }
    offset += length;
  }
  if (offset !== stringTableEnd) fail("React operations string table is misaligned", offset);

  const operations: DecodedOperation[] = [];
  const readString = (indexOffset: number, label: string): string | null => {
    const stringId = readNonNegativeInteger(values, indexOffset, label);
    if (stringId >= strings.length) fail(`${label} references unknown string ${stringId}`, indexOffset);
    return strings[stringId] ?? null;
  };
  const requireRemaining = (count: number, operationOffset: number): void => {
    if (offset + count > values.length) {
      fail("React operations opcode is missing operands", operationOffset);
    }
  };
  const readIdList = (count: number, operationOffset: number): number[] => {
    requireRemaining(count, operationOffset);
    const ids: number[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(readPositiveInteger(values, offset++, "component id"));
    }
    return ids;
  };
  const skipRects = (count: number, operationOffset: number): void => {
    if (count < -1) fail("Suspense rectangle count must be -1 or non-negative", offset - 1);
    if (count === -1) return;
    const operandCount = count * 4;
    if (!Number.isSafeInteger(operandCount)) fail("Suspense rectangle count is too large", offset - 1);
    requireRemaining(operandCount, operationOffset);
    offset += operandCount;
  };

  while (offset < values.length) {
    const operationOffset = offset;
    const opcode = readNonNegativeInteger(values, offset++, "opcode");
    switch (opcode) {
      case 1: {
        requireRemaining(2, operationOffset);
        const id = readPositiveInteger(values, offset++, "component id");
        const type = readNonNegativeInteger(values, offset++, "element type");
        if (type === ELEMENT_TYPE_ROOT) {
          requireRemaining(4, operationOffset);
          readFlag(values, offset++, "strict-mode compiled flag");
          readNonNegativeInteger(values, offset++, "profiling flags");
          readFlag(values, offset++, "supports strict mode flag");
          readFlag(values, offset++, "owner metadata flag");
          operations.push({ kind: "add-root", id, type });
        } else {
          // Keep all five fields after id/type. Omitting nameProp is the
          // easy-to-miss v7 desynchronization bug documented in design §3.9.
          requireRemaining(5, operationOffset);
          const parentId = readPositiveInteger(values, offset++, "parent id");
          const ownerId = readNonNegativeInteger(values, offset++, "owner id");
          const displayName = readString(offset++, "display-name string id");
          const key = readString(offset++, "key string id");
          const nameProp = readString(offset++, "name-prop string id");
          operations.push({
            kind: "add-node",
            id,
            type,
            parentId,
            ownerId,
            displayName,
            key,
            nameProp,
          });
        }
        break;
      }
      case 2: {
        requireRemaining(1, operationOffset);
        const count = readNonNegativeInteger(values, offset++, "remove count");
        operations.push({ kind: "remove", ids: readIdList(count, operationOffset) });
        break;
      }
      case 3: {
        requireRemaining(2, operationOffset);
        const id = readPositiveInteger(values, offset++, "parent id");
        const count = readNonNegativeInteger(values, offset++, "child count");
        operations.push({ kind: "reorder", id, children: readIdList(count, operationOffset) });
        break;
      }
      case 4:
        requireRemaining(2, operationOffset);
        operations.push({
          kind: "duration",
          id: readPositiveInteger(values, offset++, "component id"),
          duration: values[offset++]!,
        });
        break;
      case 5:
        requireRemaining(3, operationOffset);
        operations.push({
          kind: "errors",
          id: readPositiveInteger(values, offset++, "component id"),
          errors: readNonNegativeInteger(values, offset++, "error count"),
          warnings: readNonNegativeInteger(values, offset++, "warning count"),
        });
        break;
      case 6:
        operations.push({ kind: "remove-root" });
        break;
      case 7:
        requireRemaining(2, operationOffset);
        operations.push({
          kind: "subtree-mode",
          id: readPositiveInteger(values, offset++, "component id"),
          mode: readNonNegativeInteger(values, offset++, "subtree mode"),
        });
        break;
      case 8: {
        requireRemaining(5, operationOffset);
        readPositiveInteger(values, offset++, "suspense fiber id");
        readNonNegativeInteger(values, offset++, "suspense parent id");
        readString(offset++, "suspense name string id");
        readFlag(values, offset++, "suspense state flag");
        const rectCount = readInteger(values, offset++, "suspense rectangle count");
        skipRects(rectCount, operationOffset);
        operations.push({ kind: "suspense" });
        break;
      }
      case 9: {
        requireRemaining(1, operationOffset);
        const count = readNonNegativeInteger(values, offset++, "suspense remove count");
        readIdList(count, operationOffset);
        operations.push({ kind: "suspense" });
        break;
      }
      case 10: {
        requireRemaining(2, operationOffset);
        readPositiveInteger(values, offset++, "suspense parent id");
        const count = readNonNegativeInteger(values, offset++, "suspense child count");
        readIdList(count, operationOffset);
        operations.push({ kind: "suspense" });
        break;
      }
      case 11: {
        requireRemaining(2, operationOffset);
        readPositiveInteger(values, offset++, "suspense id");
        const rectCount = readInteger(values, offset++, "suspense rectangle count");
        skipRects(rectCount, operationOffset);
        operations.push({ kind: "suspense" });
        break;
      }
      case 12: {
        requireRemaining(1, operationOffset);
        const changeCount = readNonNegativeInteger(values, offset++, "suspender change count");
        for (let index = 0; index < changeCount; index += 1) {
          requireRemaining(4, operationOffset);
          readPositiveInteger(values, offset++, "suspense id");
          readFlag(values, offset++, "unique suspenders flag");
          readFlag(values, offset++, "suspended flag");
          const environmentCount = readNonNegativeInteger(
            values,
            offset++,
            "suspender environment count",
          );
          requireRemaining(environmentCount, operationOffset);
          for (let environmentIndex = 0; environmentIndex < environmentCount; environmentIndex += 1) {
            readString(offset++, "suspender environment string id");
          }
        }
        operations.push({ kind: "suspense" });
        break;
      }
      default:
        fail(`Unsupported React operations opcode ${opcode}`, operationOffset);
    }
  }

  return { rendererId, rootId, operations };
}

function readInteger(values: number[], offset: number, label: string): number {
  const value = values[offset];
  if (!isInteger(value)) fail(`${label} must be a safe integer`, offset);
  return value;
}

function readNonNegativeInteger(values: number[], offset: number, label: string): number {
  const value = readInteger(values, offset, label);
  if (value < 0) fail(`${label} must be non-negative`, offset);
  return value;
}

function readPositiveInteger(values: number[], offset: number, label: string): number {
  const value = readInteger(values, offset, label);
  if (value <= 0) fail(`${label} must be positive`, offset);
  return value;
}

function readFlag(values: number[], offset: number, label: string): number {
  const value = readInteger(values, offset, label);
  if (value !== 0 && value !== 1) fail(`${label} must be 0 or 1`, offset);
  return value;
}

const recordKey = (rendererId: number, componentId: number): string =>
  `${rendererId}:${componentId}`;

function cloneRecords(
  records: ReadonlyMap<string, ReactComponentRecord>,
): Map<string, ReactComponentRecord> {
  return new Map(
    Array.from(records, ([key, value]) => [key, { ...value, children: [...value.children] }]),
  );
}

function cloneRoots(roots: ReadonlyMap<number, ReadonlySet<number>>): Map<number, Set<number>> {
  return new Map(Array.from(roots, ([rendererId, ids]) => [rendererId, new Set(ids)]));
}

export interface ReactTreeNodeSnapshot {
  component_id: number;
  renderer_id: number;
  root_id: number;
  display_name: string | null;
  type: string;
  key: string | null;
  name_prop: string | null;
  parent_id: number | null;
  owner_id: number | null;
  depth: number;
  path: string;
  errors: number;
  warnings: number;
  truncated_children: number;
  children: ReactTreeNodeSnapshot[];
}

export interface ReactTreeSnapshot {
  generation: number;
  total_nodes: number;
  returned_nodes: number;
  truncated: boolean;
  truncation_reasons: string[];
  roots: ReactTreeNodeSnapshot[];
  renderers: ReactRendererSnapshot[];
  warnings: ReactReadWarning[];
}

export interface ReactFindMatch {
  component_id: number;
  renderer_id: number;
  root_id: number;
  display_name: string | null;
  type: string;
  key: string | null;
  depth: number;
  path: string;
}

export interface ReactReadWarning {
  code: "production_build_detected";
  message: string;
  renderer_id: number;
  renderer_package_name: string | null;
  renderer_version: string | null;
}

export interface ReactFindResult {
  generation: number;
  query: string;
  total_matches: number;
  returned_matches: number;
  truncated: boolean;
  matches: ReactFindMatch[];
  warnings: ReactReadWarning[];
}

export class ReactComponentStore {
  private generation: number;
  private records = new Map<string, ReactComponentRecord>();
  private roots = new Map<number, Set<number>>();
  private renderers = new Map<number, ReactRendererMetadata>();

  constructor(generation: number) {
    this.generation = generation;
  }

  reset(generation: number): void {
    this.generation = generation;
    this.records.clear();
    this.roots.clear();
    this.renderers.clear();
  }

  getGeneration(): number {
    return this.generation;
  }

  size(): number {
    return this.records.size;
  }

  updateRendererMetadata(metadata: ReactRendererMetadata): void {
    this.renderers.set(metadata.rendererId, { ...metadata });
  }

  getRendererMetadata(rendererId: number): ReactRendererMetadata | undefined {
    const metadata = this.renderers.get(rendererId);
    return metadata ? { ...metadata } : undefined;
  }

  rendererMetadata(): ReactRendererMetadata[] {
    return Array.from(this.renderers.values(), (metadata) => ({ ...metadata })).sort(
      (left, right) => left.rendererId - right.rendererId,
    );
  }

  unsupportedVersionMessage(): string | null {
    for (const metadata of this.rendererMetadata()) {
      const leadingVersion = metadata.version?.match(/^(\d+)(?:\.(\d+))?/);
      const major = leadingVersion?.[1] === undefined ? null : Number(leadingVersion[1]);
      const minor = leadingVersion?.[2] === undefined ? 0 : Number(leadingVersion[2]);
      const belowSupportedFloor =
        major !== null && (major < 16 || (major === 16 && minor < 8));
      if (metadata.supportsFiber === false || belowSupportedFloor) {
        const name = metadata.rendererPackageName ?? `renderer ${metadata.rendererId}`;
        const version = metadata.version ? ` ${metadata.version}` : "";
        return `${name}${version} does not expose the supported React Fiber interface. React read inspection supports React 16.8–19; upgrade React and reattach.`;
      }
    }
    return null;
  }

  readWarnings(): ReactReadWarning[] {
    return this.rendererMetadata()
      .filter((metadata) => metadata.bundleType === 0)
      .map((metadata) => ({
        code: "production_build_detected" as const,
        message: `React production build detected for ${metadata.rendererPackageName ?? `renderer ${metadata.rendererId}`}${metadata.version ? ` ${metadata.version}` : ""}. Read data is returned, but component names/source may be degraded and future override writes will be unavailable.`,
        renderer_id: metadata.rendererId,
        renderer_package_name: metadata.rendererPackageName,
        renderer_version: metadata.version,
      }));
  }

  get(componentId: number, rendererId?: number): ReactComponentRecord | null {
    if (rendererId !== undefined) {
      const record = this.records.get(recordKey(rendererId, componentId));
      return record ? { ...record, children: [...record.children] } : null;
    }
    const matches = Array.from(this.records.values()).filter((record) => record.id === componentId);
    return matches.length === 1 ? { ...matches[0]!, children: [...matches[0]!.children] } : null;
  }

  renderersFor(componentId: number): number[] {
    return Array.from(this.records.values())
      .filter((record) => record.id === componentId)
      .map((record) => record.rendererId)
      .sort((left, right) => left - right);
  }

  apply(payload: unknown, generation: number): void {
    if (generation !== this.generation) {
      throw new ReactOperationsError(
        `React operations generation ${generation} does not match materialized generation ${this.generation}`,
      );
    }
    const batch = decodeReactOperations(payload);
    const nextRecords = cloneRecords(this.records);
    const nextRoots = cloneRoots(this.roots);
    const getRequired = (id: number): ReactComponentRecord => {
      const record = nextRecords.get(recordKey(batch.rendererId, id));
      if (!record) {
        throw new ReactOperationsError(
          `React operations reference unknown component ${batch.rendererId}:${id}`,
        );
      }
      return record;
    };

    for (const operation of batch.operations) {
      switch (operation.kind) {
        case "add-root": {
          if (batch.rootId === -1) {
            throw new ReactOperationsError(
              "React operations cannot add a root in a renderer-wide batch",
            );
          }
          if (operation.id !== batch.rootId) {
            throw new ReactOperationsError(
              `React root ADD id ${operation.id} does not match batch root ${batch.rootId}`,
            );
          }
          const key = recordKey(batch.rendererId, operation.id);
          if (nextRecords.has(key)) {
            throw new ReactOperationsError(`React operations add duplicate component ${key}`);
          }
          nextRecords.set(key, {
            id: operation.id,
            rendererId: batch.rendererId,
            rootId: batch.rootId,
            type: operation.type,
            parentId: null,
            ownerId: null,
            displayName: null,
            key: null,
            nameProp: null,
            children: [],
            treeBaseDuration: null,
            errors: 0,
            warnings: 0,
            subtreeMode: null,
          });
          const rendererRoots = nextRoots.get(batch.rendererId) ?? new Set<number>();
          rendererRoots.add(operation.id);
          nextRoots.set(batch.rendererId, rendererRoots);
          break;
        }
        case "add-node": {
          if (batch.rootId === -1) {
            throw new ReactOperationsError(
              "React operations cannot add a component in a renderer-wide batch",
            );
          }
          const key = recordKey(batch.rendererId, operation.id);
          if (nextRecords.has(key)) {
            throw new ReactOperationsError(`React operations add duplicate component ${key}`);
          }
          const parent = getRequired(operation.parentId);
          if (parent.rootId !== batch.rootId) {
            throw new ReactOperationsError(
              `React component ${key} parent belongs to a different root`,
            );
          }
          if (operation.ownerId !== 0) getRequired(operation.ownerId);
          nextRecords.set(key, {
            id: operation.id,
            rendererId: batch.rendererId,
            rootId: batch.rootId,
            type: operation.type,
            parentId: operation.parentId,
            ownerId: operation.ownerId === 0 ? null : operation.ownerId,
            displayName: operation.displayName,
            key: operation.key,
            nameProp: operation.nameProp,
            children: [],
            treeBaseDuration: null,
            errors: 0,
            warnings: 0,
            subtreeMode: null,
          });
          parent.children.push(operation.id);
          break;
        }
        case "remove": {
          const removing = new Set(operation.ids);
          if (removing.size !== operation.ids.length) {
            throw new ReactOperationsError("React operations REMOVE contains duplicate component ids");
          }
          for (const id of removing) getRequired(id);
          for (const record of nextRecords.values()) {
            if (
              record.rendererId === batch.rendererId &&
              record.parentId !== null &&
              removing.has(record.parentId) &&
              !removing.has(record.id)
            ) {
              throw new ReactOperationsError(
                `React operations remove parent ${batch.rendererId}:${record.parentId} without child ${batch.rendererId}:${record.id}`,
              );
            }
          }
          for (const record of nextRecords.values()) {
            if (record.rendererId !== batch.rendererId) continue;
            record.children = record.children.filter((childId) => !removing.has(childId));
          }
          for (const id of removing) {
            nextRecords.delete(recordKey(batch.rendererId, id));
            nextRoots.get(batch.rendererId)?.delete(id);
          }
          break;
        }
        case "reorder": {
          const parent = getRequired(operation.id);
          if (new Set(operation.children).size !== operation.children.length) {
            throw new ReactOperationsError(
              `React operations reorder duplicates a child of ${batch.rendererId}:${operation.id}`,
            );
          }
          for (const childId of operation.children) {
            const child = getRequired(childId);
            if (child.parentId !== operation.id) {
              throw new ReactOperationsError(
                `React operations reorder assigns component ${batch.rendererId}:${childId} to the wrong parent`,
              );
            }
          }
          const knownChildren = new Set(parent.children);
          if (
            knownChildren.size !== operation.children.length ||
            operation.children.some((childId) => !knownChildren.has(childId))
          ) {
            throw new ReactOperationsError(
              `React operations reorder child set does not match ${batch.rendererId}:${operation.id}`,
            );
          }
          parent.children = [...operation.children];
          break;
        }
        case "duration":
          getRequired(operation.id).treeBaseDuration = operation.duration;
          break;
        case "errors": {
          const record = getRequired(operation.id);
          record.errors = operation.errors;
          record.warnings = operation.warnings;
          break;
        }
        case "subtree-mode":
          getRequired(operation.id).subtreeMode = operation.mode;
          break;
        case "remove-root": {
          if (batch.rootId === -1) {
            throw new ReactOperationsError(
              "React operations cannot remove an unspecified root",
            );
          }
          const root = getRequired(batch.rootId);
          const toRemove = new Set<number>();
          const visit = (id: number): void => {
            if (toRemove.has(id)) return;
            toRemove.add(id);
            const record = nextRecords.get(recordKey(batch.rendererId, id));
            for (const childId of record?.children ?? []) visit(childId);
          };
          visit(root.id);
          for (const id of toRemove) nextRecords.delete(recordKey(batch.rendererId, id));
          nextRoots.get(batch.rendererId)?.delete(batch.rootId);
          break;
        }
        case "suspense":
          // Suspense layout records form a separate tree. They must be parsed
          // exactly to retain alignment, but do not alter the component tree.
          break;
      }
    }

    this.records = nextRecords;
    this.roots = nextRoots;
  }

  snapshot(options: {
    maxDepth: number;
    maxChildren: number;
    maxNodes: number;
  }): ReactTreeSnapshot {
    const reasons = new Set<string>();
    let returnedNodes = 0;
    const roots: ReactTreeNodeSnapshot[] = [];
    const visit = (
      record: ReactComponentRecord,
      depth: number,
      parentPath: string | null,
    ): ReactTreeNodeSnapshot | null => {
      if (returnedNodes >= options.maxNodes) {
        reasons.add("max_nodes");
        return null;
      }
      returnedNodes += 1;
      const path = appendPath(parentPath, record);
      const childRecords = record.children.map((id) =>
        this.records.get(recordKey(record.rendererId, id)),
      );
      let visibleChildren = childRecords;
      let truncatedChildren = 0;
      if (depth >= options.maxDepth) {
        truncatedChildren = childRecords.length;
        visibleChildren = [];
        if (truncatedChildren > 0) reasons.add("max_depth");
      } else if (childRecords.length > options.maxChildren) {
        visibleChildren = childRecords.slice(0, options.maxChildren);
        truncatedChildren = childRecords.length - visibleChildren.length;
        reasons.add("max_children");
      }
      const children: ReactTreeNodeSnapshot[] = [];
      for (let index = 0; index < visibleChildren.length; index += 1) {
        const child = visibleChildren[index];
        if (!child) continue;
        const snapshot = visit(child, depth + 1, path);
        if (!snapshot) {
          truncatedChildren += visibleChildren.length - index;
          break;
        }
        children.push(snapshot);
      }
      return {
        component_id: record.id,
        renderer_id: record.rendererId,
        root_id: record.rootId,
        display_name: record.displayName,
        type: reactElementTypeName(record.type),
        key: record.key,
        name_prop: record.nameProp,
        parent_id: record.parentId,
        owner_id: record.ownerId,
        depth,
        path,
        errors: record.errors,
        warnings: record.warnings,
        truncated_children: truncatedChildren,
        children,
      };
    };

    for (const [rendererId, ids] of Array.from(this.roots.entries()).sort(
      ([left], [right]) => left - right,
    )) {
      for (const id of Array.from(ids).sort((left, right) => left - right)) {
        const record = this.records.get(recordKey(rendererId, id));
        if (!record) continue;
        const snapshot = visit(record, 0, null);
        if (!snapshot) break;
        roots.push(snapshot);
      }
    }

    return {
      generation: this.generation,
      total_nodes: this.records.size,
      returned_nodes: returnedNodes,
      truncated: reasons.size > 0,
      truncation_reasons: Array.from(reasons),
      roots,
      renderers: this.rendererMetadata().map(toReactRendererSnapshot),
      warnings: this.readWarnings(),
    };
  }

  find(options: {
    query: string;
    exact: boolean;
    caseSensitive: boolean;
    limit: number;
  }): ReactFindResult {
    const query = options.caseSensitive ? options.query : options.query.toLowerCase();
    let totalMatches = 0;
    const matches: ReactFindMatch[] = [];
    this.walk((record, depth) => {
      const name = record.displayName ?? "";
      const candidate = options.caseSensitive ? name : name.toLowerCase();
      const matched = options.exact ? candidate === query : candidate.includes(query);
      if (matched) {
        totalMatches += 1;
        if (matches.length >= options.limit) return;
        matches.push({
          component_id: record.id,
          renderer_id: record.rendererId,
          root_id: record.rootId,
          display_name: record.displayName,
          type: reactElementTypeName(record.type),
          key: record.key,
          depth,
          path: this.pathFor(record),
        });
      }
    });
    return {
      generation: this.generation,
      query: options.query,
      total_matches: totalMatches,
      returned_matches: matches.length,
      truncated: matches.length < totalMatches,
      matches,
      warnings: this.readWarnings(),
    };
  }

  private walk(visitor: (record: ReactComponentRecord, depth: number) => void): void {
    const orderedRoots: ReactComponentRecord[] = [];
    for (const [rendererId, ids] of Array.from(this.roots.entries()).sort(
      ([left], [right]) => left - right,
    )) {
      for (const id of Array.from(ids).sort((left, right) => left - right)) {
        const record = this.records.get(recordKey(rendererId, id));
        if (record) orderedRoots.push(record);
      }
    }
    const pending = orderedRoots
      .slice()
      .reverse()
      .map((record) => ({ record, depth: 0 }));
    while (pending.length > 0) {
      const current = pending.pop()!;
      visitor(current.record, current.depth);
      for (let index = current.record.children.length - 1; index >= 0; index -= 1) {
        const child = this.records.get(
          recordKey(current.record.rendererId, current.record.children[index]!),
        );
        if (child) pending.push({ record: child, depth: current.depth + 1 });
      }
    }
  }

  private pathFor(record: ReactComponentRecord): string {
    const segments: string[] = [];
    let current: ReactComponentRecord | undefined = record;
    // ADD requires an already-materialized parent, so cycles are impossible
    // for accepted batches. Keep the bound anyway so a future mutation opcode
    // cannot turn path construction into an infinite loop.
    for (let traversed = 0; current && traversed <= this.records.size; traversed += 1) {
      const label = current.displayName ?? reactElementTypeName(current.type);
      segments.push(`${label}[${current.rendererId}:${current.id}]`);
      current =
        current.parentId === null
          ? undefined
          : this.records.get(recordKey(current.rendererId, current.parentId));
    }
    if (current) {
      throw new ReactOperationsError(
        `React component ancestry contains a cycle at ${current.rendererId}:${current.id}`,
      );
    }
    return segments.reverse().join(" > ");
  }
}

function appendPath(parentPath: string | null, record: ReactComponentRecord): string {
  const label = record.displayName ?? reactElementTypeName(record.type);
  const segment = `${label}[${record.rendererId}:${record.id}]`;
  return parentPath === null ? segment : `${parentPath} > ${segment}`;
}
