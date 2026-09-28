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
    #[serde(default)]
    pub forecast: Vec<WeatherForecast>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherForecast {
    pub date: String,
    pub temperature_max: f64,
    pub temperature_min: f64,
    pub weather_code: u32,
    pub description: String,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherReport {
    pub data: CachedWeather,
    pub from_cache: bool,
    pub stale: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MenuBarStyle {
    #[default]
    Calendar,
    Date,
    WeekdayDate,
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
    #[cfg(target_os = "macos")]
    #[serde(default)]
    pub menu_bar_style: MenuBarStyle,
}

fn default_true() -> bool {
    true
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{MenuBarStyle, StoreData};

    #[test]
    fn menu_bar_style_defaults_for_existing_store() {
        let old: StoreData = serde_json::from_str(r#"{"world_clocks":[]}"#).unwrap();
        assert_eq!(old.menu_bar_style, MenuBarStyle::Calendar);

        let selected: StoreData = serde_json::from_str(r#"{"world_clocks":[],"menu_bar_style":"weekday_date"}"#).unwrap();
        assert_eq!(selected.menu_bar_style, MenuBarStyle::WeekdayDate);
        assert!(serde_json::to_string(&selected).unwrap().contains("weekday_date"));
    }
}
