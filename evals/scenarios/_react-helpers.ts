// Shared prompt + trace helpers for the React DevTools L4 scenarios.
//
// The runner's default browser system prompt tests the breakpoint/pause
// debugger workflow. These scenarios instead test the opt-in React bridge, so
// they need a React-specific SDET plan and payload-aware oracle helpers. The
// helpers deliberately grade successful tool RESULTS: a call on the wrong
// component, an error envelope, or an inspection without the expected live
// value is not evidence that the React surface worked.

export const REACT_INSPECTION_SYSTEM = `You are a Software Development Engineer in Test (SDET) doing manual exploratory testing of a TypeScript-aware React DevTools MCP integration. Your job is to verify that the dedicated React inspection tools expose the live component tree and component state accurately, then use that runtime evidence to diagnose the supplied bug.

For each scenario you receive, you have TWO goals — both are scored:

  1. React mechanic (PRIMARY). Prove that the React bridge returned the scenario-relevant live value. Merely reading source, calling a React tool that errors, or inspecting the wrong component does not test the feature.

  2. Bug identification (SECONDARY). Explain the concrete source or provider mistake and report the exact runtime value requested by the scenario.

Test plan:
  1. launch_chrome({ url, headless: true }) or launch_chrome + navigate to the page under test.
  2. attach_react_devtools. Attachment reloads the page so the backend installs before React; wait for the tool to report a ready component tree.
  3. Use get_react_tree and/or find_react_component to locate the named component. Preserve the returned component_id and renderer_id.
  4. Use inspect_react_component on that exact component. Read the returned hooks/context/props payload and record the live value the scenario asks for. If cleaned_paths hide the needed value, hydrate the returned path with a follow-up inspection.
  5. Use get_source or get_script_source only after collecting runtime evidence when source is needed to explain the cause. Source reading does not substitute for the successful React inspection.
  6. Do NOT use raw evaluate/JavaScript to read __REACT_DEVTOOLS_GLOBAL_HOOK__, __lynceusReact* globals, React fibers, or dispatch inspectElement yourself. The dedicated React tools are what this test exercises. Read-only DOM evaluation is allowed when no dedicated DOM read answers a question.
  7. Detach React DevTools and close the browser session when done.

Tool errors use a structured { error: code, message } envelope. Read the code, correct the call, and retry with current ids after reload or structural changes.

When done, give one short answer containing the requested runtime value and the precise source/provider cause.`;

export interface ReactPair {
  tool: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  errorCode?: string;
}

export interface RuntimeContextObservation {
  theme: string;
  providerId: string;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasSuccessfulReactAttach(calls: ReactPair[]): boolean {
  return calls.some((call) => {
    if (call.tool !== "attach_react_devtools" || call.isError) return false;
    const result = record(call.output);
    return (
      result.framework === "react" &&
      (result.status === "attached" || result.status === "already-attached")
    );
  });
}

/** Prove a tree/find RESULT contained the requested display name. */
export function locatedReactComponent(
  calls: ReactPair[],
  displayName: string,
): boolean {
  return calls.some((call) => {
    if (
      call.isError ||
      (call.tool !== "get_react_tree" && call.tool !== "find_react_component")
    ) {
      return false;
    }
    return deepSome(call.output, (value) => record(value).display_name === displayName);
  });
}

export function inspectedReactComponent(
  calls: ReactPair[],
  displayName: string,
): ReactPair | undefined {
  return calls.find(
    (call) =>
      call.tool === "inspect_react_component" &&
      !call.isError &&
      record(call.output).display_name === displayName,
  );
}

/** Direct or nested custom-hook State read from an inspected hooks payload. */
export function inspectionHasStateValue(
  inspection: ReactPair | undefined,
  expected: unknown,
): boolean {
  const hooks = record(record(inspection?.output).hooks).data;
  return deepSome(
    hooks,
    (value) => record(value).name === "State" && record(value).value === expected,
  );
}

/** Extract the runtime-only provider value received by SettingsWidget. */
export function readRuntimeContextObservation(
  inspection: ReactPair | undefined,
): RuntimeContextObservation | null {
  const hooks = record(record(inspection?.output).hooks).data;
  let observation: RuntimeContextObservation | null = null;
  deepSome(hooks, (value) => {
    const candidate = record(value);
    const theme = candidate.theme;
    const providerId = candidate.providerId;
    if (
      typeof theme === "string" &&
      theme !== "light" &&
      typeof providerId === "string" &&
      /^rdt-inner-[0-9a-f-]{36}$/i.test(providerId)
    ) {
      observation = { theme, providerId };
      return true;
    }
    return false;
  });
  return observation;
}

/**
 * Reject raw-JS shortcuts into the React bridge/fiber surface. The MCP
 * inspect tool's own internal Runtime.evaluate never appears as an `evaluate`
 * tool pair, so these tokens identify an agent-authored bypass. DOM-only reads
 * remain allowed.
 */
export function accessedReactInternalsViaEvaluate(calls: ReactPair[]): boolean {
  return calls.some((call) => {
    if (call.tool !== "evaluate") return false;
    let input = "";
    try {
      input = JSON.stringify(call.input ?? "");
    } catch {
      input = String(call.input);
    }
    return /__REACT_DEVTOOLS_GLOBAL_HOOK__|__lynceusReact|ReactDevToolsBackend|inspectElement|\.memoizedState|\._debugHookTypes/i.test(
      input,
    );
  });
}

function deepSome(
  value: unknown,
  predicate: (value: unknown) => boolean,
): boolean {
  if (predicate(value)) return true;
  if (Array.isArray(value)) {
    return value.some((item) => deepSome(item, predicate));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      deepSome(item, predicate),
    );
  }
  return false;
}
