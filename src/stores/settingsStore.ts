import { create } from "zustand";
import {
  DEFAULT_ACCENT,
  DEFAULT_DARK_BACKGROUND,
  DEFAULT_LIGHT_BACKGROUND,
} from "../data/colors";
import type { Language } from "../data/i18n";
import { resolveLanguage } from "../data/i18n";

export type Theme = "system" | "light" | "dark";
export type WeekStart = 0 | 1 | 6; // Sunday | Monday | Saturday (JS getDay)

export type Appearance = {
  lightAccent: string;
  lightBackground: string;
  darkAccent: string;
  darkBackground: string;
};

export type CalendarPrefs = {
  weekStart: WeekStart;
  showLunar: boolean;
  showHolidays: boolean;
  showWeekNumbers: boolean;
  keyboardShortcut: boolean;
  // Calendar events require native EventKit access that is not available on
  // every platform; the toggle is preserved as a migrated setting.
  showEvents: boolean;
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
  launchAtLogin: boolean;
  ready: boolean;

  setTheme: (theme: Theme) => void;
  setAccent: (hex: string, dark: boolean) => void;
  setBackground: (hex: string, dark: boolean) => void;
  setLanguage: (language: Language) => void;
  setCalendarPref: <K extends keyof CalendarPrefs>(key: K, value: CalendarPrefs[K]) => void;
  setUpdatePref: <K extends keyof UpdatePrefs>(key: K, value: UpdatePrefs[K]) => void;
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
};

const defaults: Persisted = {
  theme: "system",
  appearance: {
    lightAccent: DEFAULT_ACCENT,
    lightBackground: DEFAULT_LIGHT_BACKGROUND,
    darkAccent: DEFAULT_ACCENT,
    darkBackground: DEFAULT_DARK_BACKGROUND,
  },
  language: "system",
  calendar: {
    weekStart: 1,
    showLunar: true,
    showHolidays: true,
    showWeekNumbers: false,
    keyboardShortcut: true,
    showEvents: false,
  },
  update: { autoCheck: true, includeBeta: false },
};

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // One-time migration of the legacy standalone theme preference.
      const legacyTheme = localStorage.getItem("calendar-theme") as Theme | null;
      return legacyTheme ? { ...defaults, theme: legacyTheme } : defaults;
    }
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      theme: parsed.theme ?? defaults.theme,
      appearance: { ...defaults.appearance, ...parsed.appearance },
      language: parsed.language ?? defaults.language,
      calendar: { ...defaults.calendar, ...parsed.calendar },
      update: { ...defaults.update, ...parsed.update },
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
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) useSettingsStore.setState(load());
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) useSettingsStore.setState(load());
});
window.addEventListener("focus", () => useSettingsStore.setState(load()));

export function effectiveAppearance(theme: Theme, systemDark: boolean, appearance: Appearance) {
  const dark = theme === "system" ? systemDark : theme === "dark";
  return {
    dark,
    accent: dark ? appearance.darkAccent : appearance.lightAccent,
    background: dark ? appearance.darkBackground : appearance.lightBackground,
  };
}

export { resolveLanguage };
