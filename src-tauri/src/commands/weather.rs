use tauri::{Emitter, State};

use crate::domain::{StoredLocation, WeatherReport};
use crate::services::{location, weather};
use crate::state::AppState;

#[tauri::command]
pub async fn weather_get(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    language: Option<String>,
) -> Result<WeatherReport, String> {
    let now = chrono::Utc::now().timestamp();
    let (location_opt, cached, failures, last_attempt) = {
        let data = state.store.data.lock().expect("store mutex poisoned");
        (
            data.location.clone(),
            data.weather.clone(),
            data.weather_failures,
            data.last_weather_attempt,
        )
    };

    let location: StoredLocation = match location_opt {
        Some(location) => location,
        None => {
            let resolved = location::resolve_location(&state.http, None).await?;
            state.store.with(|data| data.location = Some(resolved.clone()));
            resolved
        }
    };

    // Normalize the requested language to a short BCP-47 code (e.g. "zh", "en")
    // for the reverse-geocoding service; fall back to English when unknown.
    let language = language
        .map(|raw| raw.split('_').next().unwrap_or(&raw).to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "en".to_string());

    let stale = cached
        .as_ref()
        .map(|cached| weather::is_stale(cached.fetched_at, now))
        .unwrap_or(true);
    let backoff = weather::in_backoff(failures, last_attempt, now);

    if let Some(cached) = cached {
        // Surface the cache instantly and refresh in the background when stale.
        if stale && !backoff {
            let store = state.store.clone();
            let http = state.http.clone();
            let handle = app.clone();
            let target = location.clone();
            let lang = language.clone();
            tauri::async_runtime::spawn(async move {
                match weather::fetch_fresh(&http, &target, &lang).await {
                    Ok(weather) => {
                        weather::record_success(&store, &target, &weather, now);
                        let _ = handle.emit(
                            "weather-refreshed",
                            WeatherReport {
                                data: weather,
                                from_cache: false,
                                stale: false,
                            },
                        );
                    }
                    Err(_) => weather::record_failure(&store, now),
                }
            });
        }
        return Ok(WeatherReport {
            data: cached,
            from_cache: true,
            stale,
        });
    }

    // First run: nothing cached yet, fetch synchronously so the panel shows data.
    match weather::fetch_fresh(&state.http, &location, &language).await {
        Ok(weather) => {
            weather::record_success(&state.store, &location, &weather, now);
            Ok(WeatherReport {
                data: weather,
                from_cache: false,
                stale: false,
            })
        }
        Err(err) => {
            weather::record_failure(&state.store, now);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn weather_clear_cache(state: State<'_, AppState>) {
    weather::clear_cache(&state.store);
}
