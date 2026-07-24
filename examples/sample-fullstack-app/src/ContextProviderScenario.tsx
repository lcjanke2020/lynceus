import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

interface ThemeContextValue {
  theme: string;
  providerId: string;
}

const OUTER_THEME: ThemeContextValue = {
  theme: "light",
  providerId: "outer-static",
};

const WRONG_THEMES = ["midnight", "sepia", "aurora"] as const;

const ThemeContext = createContext<ThemeContextValue>(OUTER_THEME);
ThemeContext.displayName = "ThemeContext";

function createRuntimeTheme(): ThemeContextValue {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return {
    theme: WRONG_THEMES[random % WRONG_THEMES.length]!,
    // Deliberately never rendered or copied to a page global. The exact value
    // is knowable only by inspecting the live provider/consumer fiber.
    providerId: `rdt-inner-${crypto.randomUUID()}`,
  };
}

function SettingsWidget() {
  const resolvedTheme = useContext(ThemeContext);

  return (
    <section
      id="settings-widget"
      aria-label="Settings widget"
      data-theme={resolvedTheme.theme}
    >
      <h2>Settings</h2>
      <p>The widget is visibly using the wrong theme.</p>
    </section>
  );
}

function Slot({ children }: { children: ReactNode }) {
  return <div className="settings-slot">{children}</div>;
}

function RuntimeThemeBoundary({ children }: { children: ReactNode }) {
  const [runtimeTheme] = useState<ThemeContextValue>(createRuntimeTheme);

  return (
    <ThemeContext.Provider value={runtimeTheme}>
      <Slot>{children}</Slot>
    </ThemeContext.Provider>
  );
}

function SettingsPage({ children }: { children: ReactNode }) {
  return <RuntimeThemeBoundary>{children}</RuntimeThemeBoundary>;
}

/**
 * LEO-361 bridge-mandatory case: composition places SettingsWidget beneath
 * the nearer runtime provider even though the top-level provider is light.
 */
export function ContextProviderScenario() {
  return (
    <ThemeContext.Provider value={OUTER_THEME}>
      <main aria-labelledby="provider-context-heading">
        <h1 id="provider-context-heading">Provider context test</h1>
        <p>The top-level ThemeContext provider is configured for light mode.</p>
        <SettingsPage>
          <SettingsWidget />
        </SettingsPage>
      </main>
    </ThemeContext.Provider>
  );
}
