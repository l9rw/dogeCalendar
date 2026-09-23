use crate::domain::WeatherReport;
use crate::providers::open_meteo;
use crate::services::store::Store;

const CACHE_TTL_SECONDS: i64 = 30 * 60;
const MAX_BACKOFF_SECONDS: i64 = 30 * 60;

pub async fn get_weather(
    client: &reqwest::Client,
    store: &Store,
) -> Result<WeatherReport, String> {
    let now = chrono::Utc::now().timestamp();

    let (location, cached, failures, last_attempt) = {
        let data = store.data.lock().expect("store mutex poisoned");
        (
            data.location.clone(),
            data.weather.clone(),
            data.weather_failures,
            data.last_weather_attempt,
        )
    };

    let location = match location {
        Some(location) => location,
        None => crate::services::location::resolve_location(client, None).await?,
    };

    let should_refresh = match (&cached, last_attempt) {
        (Some(cached), _) => now - cached.fetched_at >= CACHE_TTL_SECONDS,
        (None, _) => true,
    };

    let in_backoff = failures > 0
        && last_attempt
            .map(|t| now - t < backoff_seconds(failures))
            .unwrap_or(false);

    if !should_refresh {
        if let Some(cached) = cached {
            return Ok(WeatherReport {
                data: cached,
                from_cache: true,
                stale: false,
            });
        }
    }

    if in_backoff {
        if let Some(cached) = cached {
            return Ok(WeatherReport {
                data: cached,
                from_cache: true,
                stale: true,
            });
        }
        return Err("天气服务暂时不可用，请稍后重试".to_string());
    }

    match open_meteo::fetch(client, &location).await {
        Ok(weather) => {
            store.with(|data| {
                data.location = Some(location.clone());
                data.weather = Some(weather.clone());
                data.weather_failures = 0;
                data.last_weather_attempt = Some(now);
            });
            Ok(WeatherReport {
                data: weather,
                from_cache: false,
                stale: false,
            })
        }
        Err(err) => {
            store.with(|data| {
                data.weather_failures = data.weather_failures.saturating_add(1);
                data.last_weather_attempt = Some(now);
            });
            if let Some(cached) = cached {
                Ok(WeatherReport {
                    data: cached,
                    from_cache: true,
                    stale: true,
                })
            } else {
                Err(err)
            }
        }
    }
}

pub fn clear_cache(store: &Store) {
    store.with(|data| {
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
    });
}

fn backoff_seconds(failures: u32) -> i64 {
    let base = 60i64.checked_shl(failures.saturating_sub(1)).unwrap_or(0);
    base.min(MAX_BACKOFF_SECONDS)
}
