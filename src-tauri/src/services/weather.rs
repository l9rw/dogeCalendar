use crate::domain::{CachedWeather, StoredLocation};
use crate::providers::open_meteo;
use crate::services::store::Store;

const CACHE_TTL_SECONDS: i64 = 30 * 60;
const MAX_BACKOFF_SECONDS: i64 = 30 * 60;

pub fn is_stale(fetched_at: i64, now: i64) -> bool {
    now - fetched_at >= CACHE_TTL_SECONDS
}

pub fn in_backoff(failures: u32, last_attempt: Option<i64>, now: i64) -> bool {
    failures > 0
        && last_attempt
            .map(|t| now - t < backoff_seconds(failures))
            .unwrap_or(false)
}

pub async fn fetch_fresh(
    client: &reqwest::Client,
    location: &StoredLocation,
) -> Result<CachedWeather, String> {
    open_meteo::fetch(client, location).await
}

pub fn record_success(
    store: &Store,
    location: &StoredLocation,
    weather: &CachedWeather,
    now: i64,
) {
    store.with(|data| {
        data.location = Some(location.clone());
        data.weather = Some(weather.clone());
        data.weather_failures = 0;
        data.last_weather_attempt = Some(now);
    });
}

pub fn record_failure(store: &Store, now: i64) {
    store.with(|data| {
        data.weather_failures = data.weather_failures.saturating_add(1);
        data.last_weather_attempt = Some(now);
    });
}

pub fn clear_cache(store: &Store) {
    store.with(|data| {
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
    });
}

fn backoff_seconds(failures: u32) -> i64 {
    let shift = failures.saturating_sub(1).min(10);
    (60 << shift).min(MAX_BACKOFF_SECONDS)
}
