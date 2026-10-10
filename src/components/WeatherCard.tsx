import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useInfoStore } from "../stores/infoStore";
import { useSettingsStore } from "../stores/settingsStore";
import { translator } from "../data/i18n";
import type { WeatherReport } from "../services/ipc";

const ICONS: Record<string, string> = {
  sun: "☀",
  moon: "☾",
  "sun-cloud": "⛅",
  "moon-cloud": "☁",
  cloud: "☁",
  fog: "🌫",
  drizzle: "🌦",
  rain: "🌧",
  snow: "🌨",
  storm: "⛈",
};

function weatherDescription(code: number, fallback: string, inChinese: boolean) {
  if (inChinese) return fallback;
  if (code === 0) return "Clear";
  if (code <= 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67 || code >= 80 && code <= 82) return "Rain";
  if (code >= 71 && code <= 77 || code === 85 || code === 86) return "Snow";
  if (code >= 95) return "Thunderstorm";
  return "Unknown";
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "weather-refresh-icon spinning" : "weather-refresh-icon"} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.7-4L3 10m0-4v4h4M4 13a8 8 0 0 0 14.7 4L21 14m0 4v-4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WeatherCard() {
  const [refreshing, setRefreshing] = useState(false);
  const modules = useSettingsStore((state) => state.modules);
  const language = useSettingsStore((state) => state.language);
  const { t, inChinese } = useMemo(() => translator(language), [language]);
  const weather = useInfoStore((state) => state.weather);
  const loading = useInfoStore((state) => state.loadingWeather);
  const error = useInfoStore((state) => state.weatherError);
  const loadWeather = useInfoStore((state) => state.loadWeather);
  const loadLocation = useInfoStore((state) => state.loadLocation);
  const applyWeather = useInfoStore((state) => state.applyWeather);

  const weatherEnabled = modules.weather;
  const networkEnabled = modules.network;

  useEffect(() => {
    if (!weatherEnabled) return;
    let active = true;
    const listener = listen<WeatherReport>("weather-refreshed", (event) => {
      if (active) applyWeather(event.payload);
    });
    // Subscribe before requesting a stale cache's background refresh.
    void listener.then(() => {
      if (active) return loadLocation().then(() => { if (active) return loadWeather(); });
    }).catch(console.error);
    return () => {
      active = false;
      void listener.then((dispose) => dispose()).catch(console.error);
    };
  }, [weatherEnabled, networkEnabled, language, loadLocation, loadWeather, applyWeather]);

  useEffect(() => {
    if (!weatherEnabled) return;
    const onVisibility = () => {
      if (!document.hidden) void loadWeather();
    };
    const onFocus = () => void loadWeather();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [weatherEnabled, loadWeather]);

  const data = weather?.data ?? null;

  const refresh = async () => {
    if (loading || refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([loadWeather(), new Promise<void>((resolve) => window.setTimeout(resolve, 500))]);
    } finally {
      setRefreshing(false);
    }
  };

  const formatForecastDate = (value: string, index: number) => {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return inChinese ? `+${index}天` : `+${index}d`;
    if (date.toDateString() === new Date().toDateString()) return t("today");
    return date.toLocaleDateString(inChinese ? "zh-CN" : "en-US", { month: "numeric", day: "numeric" });
  };

  if (!weatherEnabled) return null;

  if (!data && loading && !refreshing) {
    return (
      <div className="weather-card weather-loading">
        <span>{t("weather.loading")}</span>
      </div>
    );
  }

  if (!data) {
    if (!networkEnabled) {
      return (
        <div className="weather-card weather-empty">
          <span className="weather-empty-text">{t("modules.offline")}</span>
        </div>
      );
    }
    return (
      <div className="weather-card weather-empty">
        <span className="weather-empty-text">
          {error ?? t("weather.empty")}
        </span>
        <button
          className="weather-refresh"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label={loading || refreshing ? t("weather.refreshing") : t("weather.refresh")}
          title={loading || refreshing ? t("weather.refreshing") : t("weather.refresh")}
        >
          <RefreshIcon spinning={loading || refreshing} />
        </button>
      </div>
    );
  }

  return (
    <div className={`weather-card ${weather?.stale ? "stale" : ""}`}>
      <div className="weather-main">
        <span className="weather-icon">{ICONS[data.icon] ?? "🌤"}</span>
        <div className="weather-temp">
          <strong>{Math.round(data.temperature)}°</strong>
          <span>{weatherDescription(data.weather_code, data.description, inChinese)}</span>
        </div>
      </div>
      <div className="weather-meta">
        <span className="weather-place">{data.location_label.split(",")[0].trim()}</span>
        {data.apparent_temperature != null && (
          <span>{t("weather.feels")} {Math.round(data.apparent_temperature)}°</span>
        )}
        {data.humidity != null && <span>{t("weather.humidity")} {Math.round(data.humidity)}%</span>}
        {data.wind_speed != null && (
          <span>{t("weather.wind")} {Math.round(data.wind_speed)} km/h</span>
        )}
      </div>
      <button
        className="weather-refresh"
        disabled={loading || refreshing || !networkEnabled}
        onClick={() => void refresh()}
        aria-label={loading || refreshing ? t("weather.refreshing") : t("weather.refresh")}
        title={loading || refreshing ? t("weather.refreshing") : t("weather.refresh")}
      >
        <RefreshIcon spinning={loading || refreshing} />
      </button>
      {!!data.forecast?.length && (
        <div className="weather-forecast" aria-label={t("weather.forecast")}>
          {data.forecast.slice(0, 3).map((item, index) => (
            <div className="weather-forecast-day" key={item.date}>
              <span>{formatForecastDate(item.date, index)}</span>
              <b>{ICONS[item.icon] ?? "🌤"}</b>
              <strong>{Math.round(item.temperature_max)}° <em>{Math.round(item.temperature_min)}°</em></strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
