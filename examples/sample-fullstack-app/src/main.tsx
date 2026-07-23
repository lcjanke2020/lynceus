import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ReactInspectorFixture } from "./ReactInspectorFixture";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element");
}
const fixture = new URLSearchParams(window.location.search).get("rdt_fixture") === "1";
createRoot(rootEl).render(fixture ? <ReactInspectorFixture /> : <App />);
