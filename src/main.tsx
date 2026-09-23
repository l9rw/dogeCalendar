import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, resolveTheme } from "./App";
import "./styles/tokens.css";

const storedTheme = (localStorage.getItem("calendar-theme") as "light" | "dark" | "system" | null) || "system";
document.documentElement.dataset.theme = resolveTheme(storedTheme, window.matchMedia("(prefers-color-scheme: dark)").matches);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
