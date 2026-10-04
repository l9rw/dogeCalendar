export type ModulePrefs = {
  weather: boolean;
  worldClock: boolean;
  almanac: boolean;
  network: boolean;
};

export const DEFAULT_MODULES: ModulePrefs = {
  weather: false,
  worldClock: false,
  almanac: false,
  network: false,
};

// Missing fields in an existing installation retain the pre-module behavior.
// New installations start offline with only the core calendar enabled.
export function loadModulePreferences(value: unknown): ModulePrefs {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(DEFAULT_MODULES).map((key) => [
    key, typeof saved[key] === "boolean" ? saved[key] : true,
  ])) as ModulePrefs;
}
