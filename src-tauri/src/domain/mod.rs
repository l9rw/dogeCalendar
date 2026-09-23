use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct City {
    pub label: String,
    pub timezone: String,
    pub country: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldClockConfig {
    pub label: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldClockSnapshot {
    pub label: String,
    pub timezone: String,
    pub time_24: String,
    pub time_12: String,
    pub date: String,
    pub weekday: String,
    pub offset_label: String,
    pub offset_minutes: i32,
    pub is_today: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredLocation {
    pub latitude: f64,
    pub longitude: f64,
    pub label: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedWeather {
    pub temperature: f64,
    pub apparent_temperature: Option<f64>,
    pub weather_code: u32,
    pub description: String,
    pub icon: String,
    pub wind_speed: Option<f64>,
    pub humidity: Option<f64>,
    pub is_day: bool,
    pub location_label: String,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherReport {
    pub data: CachedWeather,
    pub from_cache: bool,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StoreData {
    pub world_clocks: Vec<WorldClockConfig>,
    #[serde(default = "default_true")]
    pub use_24_hour: bool,
    #[serde(default)]
    pub location: Option<StoredLocation>,
    #[serde(default)]
    pub weather: Option<CachedWeather>,
    #[serde(default)]
    pub weather_failures: u32,
    #[serde(default)]
    pub last_weather_attempt: Option<i64>,
}

fn default_true() -> bool {
    true
}
