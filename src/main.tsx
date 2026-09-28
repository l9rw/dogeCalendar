import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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
document.documentElement.style.setProperty("--glass-opacity", `${settings.appearance.glassOpacity}%`);
if ("__TAURI_INTERNALS__" in window && navigator.userAgent.includes("Macintosh")) {
  document.documentElement.dataset.platform = "macos";
  void invoke<boolean>("macos_glass_enabled").then((enabled) => {
    if (enabled) document.documentElement.dataset.nativeGlass = "true";
  }).catch(console.error);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
