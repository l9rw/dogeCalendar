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
    pub is_dst: Option<bool>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreData {
    // Vec/Option fields use `#[serde(default)]` so an empty `{}` store file
    // deserializes instead of falling back to the derived Default (which would
    // also reset the boolean prefs below to false).
    #[serde(default)]
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
    // Runtime network governance flags. Default to true so existing stores and
    // first runs keep the historical behavior (background weather/IP lookups).
    #[serde(default = "default_true")]
    pub weather_enabled: bool,
    #[serde(default = "default_true")]
    pub network_enabled: bool,
    // Windows-only standalone tray fallback. Default to true so users can always
    // reach the calendar even when the taskbar-clock interception is unavailable.
    #[cfg(windows)]
    #[serde(default = "default_true")]
    pub fallback_tray_enabled: bool,
    // Windows-only taskbar-clock takeover. When false the low-level mouse hook
    // passes clock clicks through to the OS, the hover overlay is removed, and
    // clock tracking drops to an idle poll so it costs almost nothing. Default
    // true preserves the historical behavior; it cannot be turned off while the
    // fallback tray and the global shortcut are also disabled.
    #[cfg(windows)]
    #[serde(default = "default_true")]
    pub taskbar_clock_takeover_enabled: bool,
    // Global hotkey toggle. Default to true so the wake shortcut works on first
    // run; a registration conflict surfaces an error without disabling the app.
    #[serde(default = "default_true")]
    pub global_shortcut_enabled: bool,
}

// Explicit Default mirrors the serde defaults above. The store loader falls
// back to Default::default() for unparseable files, so it must yield the same
// "enabled" state as a fresh `{}` rather than `derive(Default)`'s `false`.
impl Default for StoreData {
    fn default() -> Self {
        StoreData {
            world_clocks: Vec::new(),
            use_24_hour: true,
            location: None,
            weather: None,
            weather_failures: 0,
            last_weather_attempt: None,
            #[cfg(target_os = "macos")]
            menu_bar_style: MenuBarStyle::Calendar,
            weather_enabled: true,
            network_enabled: true,
            #[cfg(windows)]
            fallback_tray_enabled: true,
            #[cfg(windows)]
            taskbar_clock_takeover_enabled: true,
            global_shortcut_enabled: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Snapshot of the global-shortcut toggle exposed to the UI. `error` is null
/// when the shortcut is registered cleanly, or a localized message when the
/// accelerator could not be claimed (e.g. another app owns the combination).
#[derive(Debug, Clone, Serialize)]
pub struct GlobalShortcutConfig {
    pub enabled: bool,
    pub shortcut: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct RuntimePreferences {
    pub weather_enabled: bool,
    pub network_enabled: bool,
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{MenuBarStyle, StoreData};

    #[test]
    fn menu_bar_style_defaults_for_existing_store() {
        let old: StoreData = serde_json::from_str(r#"{"world_clocks":[]}"#).unwrap();
        assert_eq!(old.menu_bar_style, MenuBarStyle::Calendar);

        let selected: StoreData =
            serde_json::from_str(r#"{"world_clocks":[],"menu_bar_style":"weekday_date"}"#).unwrap();
        assert_eq!(selected.menu_bar_style, MenuBarStyle::WeekdayDate);
        assert!(serde_json::to_string(&selected)
            .unwrap()
            .contains("weekday_date"));
    }
}

#[cfg(test)]
mod common_tests {
    use super::StoreData;

    #[test]
    fn empty_json_deserializes_with_enabled_defaults() {
        // First-run / corrupt-file recovery path relies on `{}` deserializing
        // (world_clocks default) with all governance flags enabled.
        let data: StoreData = serde_json::from_str("{}").unwrap();
        assert!(data.world_clocks.is_empty());
        assert!(data.use_24_hour);
        assert!(data.weather_enabled, "weather_enabled must default to true");
        assert!(data.network_enabled, "network_enabled must default to true");
        #[cfg(windows)]
        assert!(
            data.fallback_tray_enabled,
            "fallback_tray_enabled must default to true"
        );
        #[cfg(windows)]
        assert!(
            data.taskbar_clock_takeover_enabled,
            "taskbar_clock_takeover_enabled must default to true"
        );
    }

    #[test]
    fn default_impl_matches_serde_enabled_defaults() {
        let data = StoreData::default();
        assert!(data.weather_enabled);
        assert!(data.network_enabled);
        assert!(data.use_24_hour);
        #[cfg(windows)]
        assert!(data.fallback_tray_enabled);
        #[cfg(windows)]
        assert!(data.taskbar_clock_takeover_enabled);
    }

    #[test]
    fn runtime_prefs_default_true_for_existing_store() {
        let old: StoreData = serde_json::from_str(r#"{"world_clocks":[]}"#).unwrap();
        assert!(old.weather_enabled, "weather_enabled must default to true");
        assert!(old.network_enabled, "network_enabled must default to true");
        #[cfg(windows)]
        assert!(
            old.fallback_tray_enabled,
            "fallback_tray_enabled must default to true"
        );

        let disabled: StoreData = serde_json::from_str(
            r#"{"world_clocks":[],"weather_enabled":false,"network_enabled":false}"#,
        )
        .unwrap();
        assert!(!disabled.weather_enabled);
        assert!(!disabled.network_enabled);
    }

    #[test]
    fn persisted_flags_round_trip() {
        let mut data = StoreData::default();
        data.weather_enabled = false;
        data.network_enabled = true;
        let json = serde_json::to_string(&data).unwrap();
        let restored: StoreData = serde_json::from_str(&json).unwrap();
        assert!(!restored.weather_enabled);
        assert!(restored.network_enabled);
    }

    #[test]
    fn removed_date_records_do_not_reset_remaining_store_data() {
        let data: StoreData = serde_json::from_str(
            r#"{"important_dates":[{"id":"legacy","title":"Birthday","date":"2026-10-04"}],"world_clocks":[{"label":"Tokyo","timezone":"Asia/Tokyo"}],"use_24_hour":false,"network_enabled":false}"#,
        )
        .unwrap();
        assert_eq!(data.world_clocks.len(), 1);
        assert_eq!(data.world_clocks[0].timezone, "Asia/Tokyo");
        assert!(!data.use_24_hour);
        assert!(!data.network_enabled);
        let saved = serde_json::to_value(&data).unwrap();
        assert!(saved.get("important_dates").is_none());
    }

    #[test]
    fn global_shortcut_defaults_enabled_and_round_trips() {
        // Missing field must default to true so the wake shortcut works on first
        // run, and disabling must persist + round-trip.
        let fresh: StoreData = serde_json::from_str("{}").unwrap();
        assert!(fresh.global_shortcut_enabled);

        let mut data = StoreData::default();
        data.global_shortcut_enabled = false;
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains("\"global_shortcut_enabled\":false"));
        let restored: StoreData = serde_json::from_str(&json).unwrap();
        assert!(!restored.global_shortcut_enabled);
    }

    #[cfg(windows)]
    #[test]
    fn taskbar_clock_takeover_defaults_enabled_and_round_trips() {
        // First run / missing-field recovery must keep takeover enabled, and
        // disabling must persist so the hook switches to passthrough on relaunch.
        let fresh: StoreData = serde_json::from_str("{}").unwrap();
        assert!(fresh.taskbar_clock_takeover_enabled);
        assert!(fresh.fallback_tray_enabled);

        let mut data = StoreData::default();
        data.taskbar_clock_takeover_enabled = false;
        let json = serde_json::to_string(&data).unwrap();
        assert!(json.contains("\"taskbar_clock_takeover_enabled\":false"));
        let restored: StoreData = serde_json::from_str(&json).unwrap();
        assert!(!restored.taskbar_clock_takeover_enabled);
    }
}
