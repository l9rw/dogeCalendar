import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useSettingsStore, effectiveAppearance } from "./stores/settingsStore";
import "./styles/tokens.css";

const settings = useSettingsStore.getState();
const { dark, accent, background } = effectiveAppearance(
  settings.theme,
  window.matchMedia("(prefers-color-scheme: dark)").matches,
  settings.appearance,
);
document.documentElement.dataset.theme = dark ? "dark" : "light";
document.documentElement.style.setProperty("--blue", accent);
document.documentElement.style.setProperty("--shell-bg", background);
if ("__TAURI_INTERNALS__" in window && navigator.userAgent.includes("Macintosh")) {
  document.documentElement.dataset.platform = "macos";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
