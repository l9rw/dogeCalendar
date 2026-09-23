import { useEffect } from "react";
import { useInfoStore } from "../stores/infoStore";

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

export function WeatherCard() {
  const weather = useInfoStore((state) => state.weather);
  const loading = useInfoStore((state) => state.loadingWeather);
  const error = useInfoStore((state) => state.weatherError);
  const loadWeather = useInfoStore((state) => state.loadWeather);
  const loadLocation = useInfoStore((state) => state.loadLocation);

  useEffect(() => {
    loadLocation().then(() => loadWeather());
  }, [loadLocation, loadWeather]);

  const data = weather?.data ?? null;

  if (!data && loading) {
    return (
      <div className="weather-card weather-loading">
        <span>正在获取天气…</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="weather-card weather-empty">
        <span className="weather-empty-text">
          {error ?? "暂无天气信息"}
        </span>
        <button className="weather-refresh" onClick={() => loadWeather()}>
          获取天气
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
          <span>{data.description}</span>
        </div>
      </div>
      <div className="weather-meta">
        <span className="weather-place">{data.location_label}</span>
        {data.apparent_temperature != null && (
          <span>体感 {Math.round(data.apparent_temperature)}°</span>
        )}
        {data.humidity != null && <span>湿度 {Math.round(data.humidity)}%</span>}
        {data.wind_speed != null && (
          <span>风速 {Math.round(data.wind_speed)} km/h</span>
        )}
      </div>
      <button
        className="weather-refresh"
        disabled={loading}
        onClick={() => loadWeather()}
      >
        {loading ? "刷新中" : "刷新"}
      </button>
    </div>
  );
}
