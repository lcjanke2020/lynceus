import {
  Component,
  createContext,
  useContext,
  useEffect,
  useState,
  type ContextType,
  type ReactNode,
} from "react";

interface FixtureContextValue {
  theme: "midnight";
  fontScale: number;
}

const FIXTURE_CONTEXT: FixtureContextValue = {
  theme: "midnight",
  fontScale: 1.25,
};

const InspectorContext = createContext<FixtureContextValue>({
  theme: "midnight",
  fontScale: 1,
});
InspectorContext.displayName = "InspectorContext";

function useFixtureCounter(initialCount: number): number {
  const [count] = useState(initialCount);
  useEffect(() => {
    document.title = `RDT fixture count ${count}`;
  }, [count]);
  return count;
}

interface InspectorWidgetProps {
  label: string;
}

function InspectorWidget({ label }: InspectorWidgetProps) {
  const settings = useContext(InspectorContext);
  const count = useFixtureCounter(2);

  useEffect(() => {
    document.documentElement.dataset.rdtTheme = settings.theme;
    return () => {
      delete document.documentElement.dataset.rdtTheme;
    };
  }, [settings.theme]);

  return (
    <p id="rdt-widget">
      {label}: {count} ({settings.theme}, {settings.fontScale})
    </p>
  );
}

interface InspectorStateBoxProps {
  label: string;
}

class InspectorStateBox extends Component<
  InspectorStateBoxProps,
  { status: "ready" }
> {
  static contextType = InspectorContext;
  declare context: ContextType<typeof InspectorContext>;

  state = { status: "ready" as const };

  render(): ReactNode {
    return (
      <p id="rdt-state-box">
        {this.props.label}: {this.state.status} / {this.context.theme}
      </p>
    );
  }
}

function FixtureRow({ name }: { name: string }) {
  return <li data-rdt-row={name}>{name}</li>;
}

export function ReactInspectorFixture() {
  const [rows, setRows] = useState(["alpha", "beta"]);

  useEffect(() => {
    document.documentElement.dataset.rdtFixture = "ready";
    return () => {
      delete document.documentElement.dataset.rdtFixture;
    };
  }, []);

  return (
    <InspectorContext.Provider value={FIXTURE_CONTEXT}>
      <section aria-label="React inspector fixture">
        <InspectorWidget label="runtime-widget" />
        <InspectorStateBox label="runtime-state" />
        <ul id="rdt-rows">
          {rows.map((row) => (
            <FixtureRow key={row} name={row} />
          ))}
        </ul>
        <button
          id="rdt-add-row"
          type="button"
          onClick={() => setRows((current) => [...current, `row-${current.length + 1}`])}
        >
          Add fixture row
        </button>
      </section>
    </InspectorContext.Provider>
  );
}
