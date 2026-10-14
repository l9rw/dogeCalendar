import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./App";
import { useSettingsStore, applyAppearance, syncRuntimePreferences } from "./stores/settingsStore";
import "./styles/tokens.css";
import "./styles/themes.css";

const settings = useSettingsStore.getState();
applyAppearance(
  settings.theme,
  window.matchMedia("(prefers-color-scheme: dark)").matches,
  settings.appearance,
);
if ("__TAURI_INTERNALS__" in window) {
  void syncRuntimePreferences().catch(console.error);
  document.documentElement.dataset.platform = navigator.userAgent.includes("Macintosh") ? "macos" : "windows";
  if (document.documentElement.dataset.platform === "macos") {
    void invoke<boolean>("macos_glass_enabled").then((enabled) => {
      if (enabled) document.documentElement.dataset.nativeGlass = "true";
    }).catch(console.error);
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
