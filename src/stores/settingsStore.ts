import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_ACCENT,
  DEFAULT_DARK_BACKGROUND,
  DEFAULT_LIGHT_BACKGROUND,
} from "../data/colors";
import type { Language } from "../data/i18n";
import { resolveLanguage } from "../data/i18n";
import { DEFAULT_MODULES, loadModulePreferences, type ModulePrefs } from "../services/modulePreferences";
export type { ModulePrefs } from "../services/modulePreferences";

export type Theme = "system" | "light" | "dark";
export type WeekStart = 0 | 1 | 6; // Sunday | Monday | Saturday (JS getDay)

export type Appearance = {
  lightAccent: string;
  lightBackground: string;
  darkAccent: string;
  darkBackground: string;
  glassOpacity: number;
};

export type CalendarPrefs = {
  weekStart: WeekStart;
  showLunar: boolean;
  showHolidays: boolean;
  showWeekNumbers: boolean;
  keyboardShortcut: boolean;
};

export type UpdatePrefs = {
  autoCheck: boolean;
  includeBeta: boolean;
};

export type SettingsState = {
  theme: Theme;
  appearance: Appearance;
  language: Language;
  calendar: CalendarPrefs;
  update: UpdatePrefs;
  modules: ModulePrefs;
  launchAtLogin: boolean;
  ready: boolean;

  setTheme: (theme: Theme) => void;
  setAccent: (hex: string, dark: boolean) => void;
  setBackground: (hex: string, dark: boolean) => void;
  setGlassOpacity: (opacity: number) => void;
  setLanguage: (language: Language) => void;
  setCalendarPref: <K extends keyof CalendarPrefs>(key: K, value: CalendarPrefs[K]) => void;
  setUpdatePref: <K extends keyof UpdatePrefs>(key: K, value: UpdatePrefs[K]) => void;
  setModulePref: <K extends keyof ModulePrefs>(key: K, value: ModulePrefs[K]) => void;
  setLaunchAtLogin: (enabled: boolean) => void;
  hydrateLaunchAtLogin: (enabled: boolean) => void;
};

const STORAGE_KEY = "calendar-settings";

type Persisted = {
  theme: Theme;
  appearance: Appearance;
  language: Language;
  calendar: CalendarPrefs;
  update: UpdatePrefs;
  modules: ModulePrefs;
};

const defaults: Persisted = {
  theme: "system",
  appearance: {
    lightAccent: DEFAULT_ACCENT,
    lightBackground: DEFAULT_LIGHT_BACKGROUND,
    darkAccent: DEFAULT_ACCENT,
    darkBackground: DEFAULT_DARK_BACKGROUND,
    glassOpacity: 12,
  },
  language: "system",
  calendar: {
    weekStart: 1,
    showLunar: true,
    showHolidays: true,
    showWeekNumbers: false,
    keyboardShortcut: true,
  },
  update: { autoCheck: true, includeBeta: false },
  modules: DEFAULT_MODULES,
};

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // One-time migration of the legacy standalone theme preference.
      const legacyTheme = localStorage.getItem("calendar-theme") as Theme | null;
      return legacyTheme ? { ...defaults, theme: legacyTheme, modules: loadModulePreferences(undefined) } : defaults;
    }
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const savedOpacity = parsed.appearance?.glassOpacity;
    return {
      theme: parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? parsed.theme : defaults.theme,
      appearance: {
        ...defaults.appearance,
        ...Object.fromEntries(Object.entries(parsed.appearance ?? {}).filter(([key, value]) => key in defaults.appearance && typeof value === "string" && /^#[\da-f]{6}$/i.test(value))),
        glassOpacity: typeof savedOpacity === "number" && Number.isFinite(savedOpacity)
          ? Math.max(0, Math.min(100, savedOpacity))
          : defaults.appearance.glassOpacity,
      },
      language: parsed.language === "zh_CN" || parsed.language === "en_US" || parsed.language === "system" ? parsed.language : defaults.language,
      calendar: {
        ...defaults.calendar,
        ...Object.fromEntries(Object.entries(parsed.calendar ?? {}).filter(([key, value]) => key in defaults.calendar && typeof value === "boolean")),
        weekStart: parsed.calendar?.weekStart === 0 || parsed.calendar?.weekStart === 1 || parsed.calendar?.weekStart === 6 ? parsed.calendar.weekStart : defaults.calendar.weekStart,
      },
      update: { ...defaults.update, ...Object.fromEntries(Object.entries(parsed.update ?? {}).filter(([key, value]) => key in defaults.update && typeof value === "boolean")) },
      modules: loadModulePreferences(parsed.modules),
    };
  } catch {
    return defaults;
  }
}

function persist(state: SettingsState) {
  const data: Persisted = {
    theme: state.theme,
    appearance: state.appearance,
    language: state.language,
    calendar: state.calendar,
    update: state.update,
    modules: state.modules,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore quota errors
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const initial = load();
  return {
    theme: initial.theme,
    appearance: initial.appearance,
    language: initial.language,
    calendar: initial.calendar,
    update: initial.update,
    modules: initial.modules,
    launchAtLogin: false,
    ready: false,

    setTheme: (theme) => {
      set({ theme });
      persist(get());
    },
    setAccent: (hex, dark) => {
      const appearance = { ...get().appearance };
      if (dark) appearance.darkAccent = hex;
      else appearance.lightAccent = hex;
      set({ appearance });
      persist(get());
    },
    setBackground: (hex, dark) => {
      const appearance = { ...get().appearance };
      if (dark) appearance.darkBackground = hex;
      else appearance.lightBackground = hex;
      set({ appearance });
      persist(get());
    },
    setGlassOpacity: (opacity) => {
      if (!Number.isFinite(opacity)) return;
      set({ appearance: { ...get().appearance, glassOpacity: Math.max(0, Math.min(100, opacity)) } });
      persist(get());
    },
    setLanguage: (language) => {
      set({ language });
      persist(get());
    },
    setCalendarPref: (key, value) => {
      set({ calendar: { ...get().calendar, [key]: value } });
      persist(get());
    },
    setUpdatePref: (key, value) => {
      set({ update: { ...get().update, [key]: value } });
      persist(get());
    },
    setModulePref: (key, value) => {
      set({ modules: { ...get().modules, [key]: value } });
      persist(get());
    },
    setLaunchAtLogin: (enabled) => {
      set({ launchAtLogin: enabled });
      // persistence is owned by the OS login manager, not localStorage
    },
    hydrateLaunchAtLogin: (enabled) => {
      set({ launchAtLogin: enabled, ready: true });
    },
  };
});

// Auxiliary panels run in separate WebViews and need to observe settings saved by the main window.
function reloadSettings() {
  const next = load();
  const current = useSettingsStore.getState();
  if (JSON.stringify({ theme: current.theme, appearance: current.appearance, language: current.language, calendar: current.calendar, update: current.update, modules: current.modules }) !== JSON.stringify(next)) {
    useSettingsStore.setState(next);
  }
}
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) reloadSettings();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reloadSettings();
});
window.addEventListener("focus", reloadSettings);

export async function syncRuntimePreferences() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { modules } = useSettingsStore.getState();
  await invoke("runtime_preferences_set", {
    weatherEnabled: modules.weather,
    networkEnabled: modules.network,
  });
}

useSettingsStore.subscribe((state, previous) => {
  if (state.modules !== previous.modules) void syncRuntimePreferences().catch(console.error);
});

export function effectiveAppearance(theme: Theme, systemDark: boolean, appearance: Appearance) {
  const dark = theme === "system" ? systemDark : theme === "dark";
  return {
    dark,
    accent: dark ? appearance.darkAccent : appearance.lightAccent,
    background: dark ? appearance.darkBackground : appearance.lightBackground,
  };
}

export { resolveLanguage };
