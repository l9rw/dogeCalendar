import { invoke } from "@tauri-apps/api/core";

export type City = {
  label: string;
  timezone: string;
  country?: string;
};

export type WorldClockSnapshot = {
  label: string;
  timezone: string;
  time_24: string;
  time_12: string;
  date: string;
  weekday: string;
  offset_label: string;
  offset_minutes: number;
  is_today: boolean;
};

export type StoredLocation = {
  latitude: number;
  longitude: number;
  label: string;
  source: string;
};

export type CachedWeather = {
  temperature: number;
  apparent_temperature?: number;
  weather_code: number;
  description: string;
  icon: string;
  wind_speed?: number;
  humidity?: number;
  is_day: boolean;
  location_label: string;
  fetched_at: number;
};

export type WeatherReport = {
  data: CachedWeather;
  from_cache: boolean;
  stale: boolean;
};

export const worldTimeApi = {
  listCities: () => invoke<City[]>("world_time_list_cities"),
  search: (query: string) => invoke<City[]>("world_time_search", { query }),
  clocks: () => invoke<WorldClockSnapshot[]>("world_time_clocks"),
  use24Hour: () => invoke<boolean>("world_time_use_24_hour"),
  setUse24Hour: (enabled: boolean) =>
    invoke<void>("world_time_set_use_24_hour", { enabled }),
  add: (label: string, timezone: string) =>
    invoke<void>("world_time_add", { label, timezone }),
  remove: (timezone: string) =>
    invoke<void>("world_time_remove", { timezone }),
  reorder: (timezones: string[]) =>
    invoke<void>("world_time_reorder", { timezones }),
};

export const locationApi = {
  get: () => invoke<StoredLocation | null>("location_get"),
  setManual: (latitude: number, longitude: number, label: string) =>
    invoke<StoredLocation>("location_set_manual", { latitude, longitude, label }),
  clear: () => invoke<void>("location_clear"),
};

export const weatherApi = {
  get: () => invoke<WeatherReport>("weather_get"),
  clearCache: () => invoke<void>("weather_clear_cache"),
};
