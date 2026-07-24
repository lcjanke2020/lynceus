import type { ScriptStore } from "../sourcemap/store.js";
import {
  MAP_LOAD_WAIT_MS,
  mapCdpToOriginal,
  waitForConsumer,
} from "../sourcemap/store.js";

export interface ReactOriginalSource {
  file: string;
  line: number;
  column: number;
  component_name: string | null;
  generated: {
    url: string;
    line: number;
    column: number;
    script_id: string;
    session_id: string | null;
  };
}

export interface ReactSourceResolution {
  source: ReactOriginalSource | null;
  source_note: string | null;
}

interface ReactSourceTuple {
  componentName: string | null;
  url: string;
  line: number;
  column: number;
}

/** Resolve React's 1-based generated tuple through the existing source maps. */
export async function resolveReactSource(
  store: ScriptStore,
  rawSource: unknown,
  executionContextId: number | undefined,
  sessionId: string | null = null,
): Promise<ReactSourceResolution> {
  if (rawSource === null || rawSource === undefined) {
    return {
      source: null,
      source_note:
        "React did not report a source for this fiber. This is normal for roots, providers, boundaries, and some structural components.",
    };
  }
  const tuple = parseReactSourceTuple(rawSource);
  if (!tuple) {
    return {
      source: null,
      source_note:
        "React reported a source location in an unrecognized format; component data is still available.",
    };
  }

  const findCandidates = () =>
    store
      .findByUrl(tuple.url)
      .filter((candidate) => (candidate.sessionId ?? null) === sessionId);
  const hasPendingCandidate = () =>
    findCandidates().some(
      (candidate) =>
        candidate.sourceMapURL && !candidate.consumer && !candidate.loadError,
    );

  // waitForConsumer's generic pending check is store-wide. Only enter it
  // when this URL/session has a map in flight, and make its predicate finish
  // as soon as those candidates settle so unrelated scripts cannot impose
  // the shared 500 ms map-load budget on React inspection.
  if (hasPendingCandidate()) {
    await waitForConsumer(
      store,
      () =>
        findCandidates().some((candidate) => candidate.consumer !== undefined) ||
        !hasPendingCandidate(),
      Date.now() + MAP_LOAD_WAIT_MS,
    );
  }
  const candidates = findCandidates();
  if (candidates.length === 0) {
    return {
      source: null,
      source_note: `React reported ${tuple.url}:${tuple.line}:${tuple.column}, but no parsed script in the originating CDP agent has that URL.`,
    };
  }

  const contextMatches =
    executionContextId === undefined
      ? candidates
      : candidates.filter(
          (candidate) => candidate.executionContextId === executionContextId,
        );
  if (executionContextId !== undefined && contextMatches.length === 0) {
    return {
      source: null,
      source_note: `React reported ${tuple.url}:${tuple.line}:${tuple.column}, but every parsed script candidate belongs to a different execution context.`,
    };
  }
  const provenanceCandidates = contextMatches;
  const generatedLine = tuple.line - 1;
  const generatedColumn = tuple.column - 1;
  const rangeMatches = provenanceCandidates.filter((candidate) => {
    if (generatedLine < candidate.startLine || generatedLine > candidate.endLine) return false;
    if (generatedLine === candidate.startLine && generatedColumn < candidate.startColumn) return false;
    if (generatedLine === candidate.endLine && generatedColumn > candidate.endColumn) return false;
    return true;
  });
  const eligible = rangeMatches.length > 0 ? rangeMatches : provenanceCandidates;
  const mapped = eligible.flatMap((candidate) => {
    const original = mapCdpToOriginal(
      store,
      {
        scriptId: candidate.scriptId,
        lineNumber: generatedLine,
        columnNumber: generatedColumn,
      },
      candidate.sessionId,
    );
    if (!original) return [];
    return [
      {
        original,
        candidate,
      },
    ];
  });

  if (mapped.length === 0) {
    const pending = eligible.some(
      (candidate) => candidate.sourceMapURL && !candidate.consumer && !candidate.loadError,
    );
    return {
      source: null,
      source_note: pending
        ? `React reported ${tuple.url}:${tuple.line}:${tuple.column}, but its source map is still loading. Retry inspection.`
        : `React reported ${tuple.url}:${tuple.line}:${tuple.column}, but no original TypeScript mapping covers that generated coordinate.`,
    };
  }

  const distinct = new Map<
    string,
    (typeof mapped)[number]
  >();
  for (const result of mapped) {
    const key = `${result.original.file}:${result.original.line}:${result.original.column}`;
    if (!distinct.has(key)) distinct.set(key, result);
  }
  if (distinct.size > 1) {
    return {
      source: null,
      source_note: `React source ${tuple.url}:${tuple.line}:${tuple.column} maps to multiple original locations across ${eligible.length} script candidates; attribution is ambiguous.`,
    };
  }

  const selected = distinct.values().next().value;
  if (!selected) {
    return {
      source: null,
      source_note: "React source attribution unexpectedly produced no mapping.",
    };
  }
  return {
    source: {
      ...selected.original,
      component_name: tuple.componentName,
      generated: {
        url: tuple.url,
        line: tuple.line,
        column: tuple.column,
        script_id: selected.candidate.scriptId,
        session_id: selected.candidate.sessionId ?? null,
      },
    },
    source_note: null,
  };
}

function parseReactSourceTuple(value: unknown): ReactSourceTuple | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [componentName, url, line, column] = value;
  if (
    (componentName !== null && typeof componentName !== "string") ||
    typeof url !== "string" ||
    url.length === 0 ||
    !Number.isSafeInteger(line) ||
    (line as number) < 1 ||
    !Number.isSafeInteger(column) ||
    (column as number) < 1
  ) {
    return null;
  }
  return {
    componentName: componentName as string | null,
    url,
    line: line as number,
    column: column as number,
  };
}
