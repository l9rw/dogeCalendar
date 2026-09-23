import { create } from "zustand";
import {
  locationApi,
  weatherApi,
  worldTimeApi,
  type City,
  type StoredLocation,
  type WeatherReport,
  type WorldClockSnapshot,
} from "../services/ipc";

type InfoState = {
  clocks: WorldClockSnapshot[];
  use24Hour: boolean;
  weather: WeatherReport | null;
  location: StoredLocation | null;
  searchResults: City[];
  searching: boolean;
  loadingWeather: boolean;
  weatherError: string | null;

  loadClocks: () => Promise<void>;
  loadUse24Hour: () => Promise<void>;
  setUse24Hour: (enabled: boolean) => Promise<void>;
  addClock: (city: City) => Promise<void>;
  removeClock: (timezone: string) => Promise<void>;
  reorderClocks: (timezones: string[]) => Promise<void>;
  search: (query: string) => Promise<void>;

  loadWeather: () => Promise<void>;
  applyWeather: (report: WeatherReport) => void;
  clearWeatherCache: () => Promise<void>;
  loadLocation: () => Promise<void>;
  setManualLocation: (
    latitude: number,
    longitude: number,
    label: string,
  ) => Promise<void>;
  clearLocation: () => Promise<void>;
};

export const useInfoStore = create<InfoState>((set, get) => ({
  clocks: [],
  use24Hour: true,
  weather: null,
  location: null,
  searchResults: [],
  searching: false,
  loadingWeather: false,
  weatherError: null,

  loadClocks: async () => {
    const clocks = await worldTimeApi.clocks();
    set({ clocks });
  },

  loadUse24Hour: async () => {
    const use24Hour = await worldTimeApi.use24Hour();
    set({ use24Hour });
  },

  setUse24Hour: async (enabled) => {
    await worldTimeApi.setUse24Hour(enabled);
    set({ use24Hour: enabled });
    await get().loadClocks();
  },

  addClock: async (city) => {
    await worldTimeApi.add(city.label, city.timezone);
    await get().loadClocks();
  },

  removeClock: async (timezone) => {
    await worldTimeApi.remove(timezone);
    await get().loadClocks();
  },

  reorderClocks: async (timezones) => {
    await worldTimeApi.reorder(timezones);
    await get().loadClocks();
  },

  search: async (query) => {
    set({ searching: true });
    try {
      const results = await worldTimeApi.search(query);
      set({ searchResults: results });
    } finally {
      set({ searching: false });
    }
  },

  loadWeather: async () => {
    set({ loadingWeather: true, weatherError: null });
    try {
      const report = await weatherApi.get();
      set({ weather: report });
    } catch (error) {
      set({
        weatherError: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set({ loadingWeather: false });
    }
  },

  applyWeather: (report) => set({ weather: report }),

  clearWeatherCache: async () => {
    await weatherApi.clearCache();
    set({ weather: null });
  },

  loadLocation: async () => {
    try {
      const location = await locationApi.get();
      set({ location });
    } catch {
      set({ location: null });
    }
  },

  setManualLocation: async (latitude, longitude, label) => {
    const location = await locationApi.setManual(latitude, longitude, label);
    set({ location, weather: null });
    await get().loadWeather();
  },

  clearLocation: async () => {
    await locationApi.clear();
    set({ location: null, weather: null });
  },
}));
