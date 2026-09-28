import { useEffect, useState } from "react";
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

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? "weather-refresh-icon spinning" : "weather-refresh-icon"} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.7-4L3 10m0-4v4h4M4 13a8 8 0 0 0 14.7 4L21 14m0 4v-4h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function forecastDate(value: string, index: number) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return index === 0 ? "今天" : `+${index}天`;
  return index === 0 ? "今天" : `${date.getMonth() + 1}/${date.getDate()}`;
}

export function WeatherCard() {
  const [refreshing, setRefreshing] = useState(false);
  const weather = useInfoStore((state) => state.weather);
  const loading = useInfoStore((state) => state.loadingWeather);
  const error = useInfoStore((state) => state.weatherError);
  const loadWeather = useInfoStore((state) => state.loadWeather);
  const loadLocation = useInfoStore((state) => state.loadLocation);

  useEffect(() => {
    loadLocation().then(() => loadWeather());
  }, [loadLocation, loadWeather]);

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

  if (!data && loading && !refreshing) {
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
        <button className="weather-refresh" disabled={loading} onClick={() => void refresh()} aria-label={loading ? "刷新中" : "获取天气"} title={loading ? "刷新中" : "获取天气"}>
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
          <span>{data.description}</span>
        </div>
      </div>
      <div className="weather-meta">
        <span className="weather-place">{data.location_label.split(",")[0].trim()}</span>
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
        disabled={loading || refreshing}
        onClick={() => void refresh()}
        aria-label={loading || refreshing ? "刷新中" : "刷新天气"}
        title={loading || refreshing ? "刷新中" : "刷新天气"}
      >
        <RefreshIcon spinning={loading || refreshing} />
      </button>
      {!!data.forecast?.length && (
        <div className="weather-forecast" aria-label="未来三天天气">
          {data.forecast.slice(0, 3).map((item, index) => (
            <div className="weather-forecast-day" key={item.date}>
              <span>{forecastDate(item.date, index)}</span>
              <b>{ICONS[item.icon] ?? "🌤"}</b>
              <strong>{Math.round(item.temperature_max)}° <em>{Math.round(item.temperature_min)}°</em></strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
