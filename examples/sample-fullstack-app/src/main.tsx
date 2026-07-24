import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextProviderScenario } from "./ContextProviderScenario";
import { ReactInspectorFixture } from "./ReactInspectorFixture";
import { StaleCounter } from "./StaleCounter";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}
const params = new URLSearchParams(window.location.search);
const fixture = params.get("rdt_fixture") === "1";
const scenario = params.get("rdt_scenario");

const page =
  scenario === "stale-closure" ? (
    <StaleCounter />
  ) : scenario === "context-provider" ? (
    <ContextProviderScenario />
  ) : fixture ? (
    <ReactInspectorFixture />
  ) : (
    <App />
  );

createRoot(rootEl).render(page);
