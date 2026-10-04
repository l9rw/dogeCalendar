use std::sync::atomic::Ordering;

use tauri::{Emitter, State};

use crate::domain::{CachedWeather, StoredLocation, WeatherReport};
use crate::services::{location, weather};
use crate::state::AppState;

/// Outcome when the in-flight resolve/fetch was cancelled or superseded. Prefer
/// any cached weather (stale) so the panel keeps showing the last known state;
/// otherwise surface a clear cancellation error. Never issues a new request.
fn weather_after_cancel(
    _state: &State<'_, AppState>,
    cached: Option<CachedWeather>,
) -> Result<WeatherReport, String> {
    if let Some(cached) = cached {
        return Ok(WeatherReport {
            data: cached,
            from_cache: true,
            stale: true,
        });
    }
    Err("天气刷新已取消".into())
}

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

    // Runtime network governance: when weather or network is disabled, never
    // start a fresh request. Existing cache is still surfaced (marked stale) so
    // the panel keeps showing the last known conditions; manual location saves
    // remain unaffected. This guard runs before any IP resolution so a disabled
    // weather module also blocks IP-based location lookups via weather_get.
    if !state.weather_enabled() || !state.network_enabled() {
        if let Some(cached) = cached {
            return Ok(WeatherReport {
                data: cached,
                from_cache: true,
                stale: true,
            });
        }
        return Err("天气数据未启用或网络已关闭".into());
    }

    let location: StoredLocation = match location_opt {
        Some(location) => location,
        None => {
            // IP resolution is governed like the weather fetch: a select! on the
            // cancel notify aborts it when location/cache/preferences change, and
            // a generation + flag check after the resolve prevents a late IP
            // result from overwriting a manual location chosen mid-resolve or
            // committing after weather/network was disabled.
            let generation = state.weather_task.generation();
            let cancel = state.weather_task.cancel_notify();
            let resolved = tokio::select! {
                result = location::resolve_location(&state.http, None) => result,
                _ = cancel.notified() => {
                    return weather_after_cancel(&state, cached);
                }
            }?;
            if generation != state.weather_task.generation()
                || !state.weather_enabled()
                || !state.network_enabled()
            {
                return weather_after_cancel(&state, cached);
            }
            state.store.transaction(|data| {
                if generation != state.weather_task.generation()
                    || !state.network_enabled()
                    || !state.weather_enabled()
                {
                    return Err("Location lookup cancelled".into());
                }
                if data.location.is_none() {
                    data.location = Some(resolved);
                }
                data.location
                    .clone()
                    .ok_or_else(|| "Location unavailable".to_string())
            })?
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
            spawn_background_refresh(&state, &app, location, language, now);
        }
        return Ok(WeatherReport {
            data: cached,
            from_cache: true,
            stale,
        });
    }

    // First run: nothing cached yet, fetch synchronously so the panel shows data.
    // The synchronous fetch is also governed: a select! on the cancel notify
    // aborts the in-flight request when location/cache/preferences change, and a
    // generation guard after the fetch discards a result that was superseded.
    let generation = state.weather_task.generation();
    let cancel = state.weather_task.cancel_notify();
    let outcome = tokio::select! {
        result = weather::fetch_fresh(&state.http, &location, &language) => result,
        _ = cancel.notified() => return Err("天气刷新已取消".into()),
    };
    // Superseded by a location/cache/preference change while in flight, or the
    // flags flipped during the fetch: discard instead of recording.
    if generation != state.weather_task.generation()
        || !state.weather_enabled()
        || !state.network_enabled()
    {
        return Err("天气刷新已取消".into());
    }
    match outcome {
        Ok(weather) => {
            let committed = state.store.transaction(|data| {
                if generation != state.weather_task.generation()
                    || !state.weather_enabled()
                    || !state.network_enabled()
                    || !data.location.as_ref().is_some_and(|current| {
                        current.latitude == location.latitude
                            && current.longitude == location.longitude
                            && current.source == location.source
                    })
                {
                    return Err("Weather refresh cancelled".into());
                }
                data.weather = Some(weather.clone());
                data.weather_failures = 0;
                data.last_weather_attempt = Some(now);
                Ok(())
            });
            committed?;
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

/// De-duplicates and governs the background weather refresh. The task captures
/// the live flags, the generation at spawn time, and the target location, then:
/// - re-checks the flags immediately before issuing the request (so toggling
///   network/weather off stops new requests even without an abort),
/// - is abortable via the tracked JoinHandle (cancelled on location change,
///   cache clear, or preference disable), which drops the in-flight reqwest
///   future and its reverse-geocoding follow-up,
/// - on success re-checks the generation and the stored location before
///   recording, so a stale result can never overwrite a newer manual location
///   or a freshly cleared cache.
fn spawn_background_refresh(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    location: StoredLocation,
    language: String,
    now: i64,
) {
    let store = state.store.clone();
    let http = state.http.clone();
    let handle = app.clone();
    let target = location.clone();
    let lang = language;
    let weather_flag = state.weather_flag();
    let network_flag = state.network_flag();
    let generation_handle = state.weather_task.generation_handle();
    let generation = generation_handle.load(Ordering::Relaxed);
    let target_latitude = target.latitude;
    let target_longitude = target.longitude;
    let target_source = target.source.clone();

    // De-duplicate by skipping while a refresh is in flight (rather than
    // abort-restart, which would starve a slow provider). If a refresh is
    // running, replace_if_idle returns false and the spawn closure is never
    // called, so no task is orphaned.
    let spawned = state.weather_task.replace_if_idle(|| {
        tauri::async_runtime::spawn(async move {
            // Guard immediately before any network call.
            if !weather_flag.load(Ordering::Relaxed) || !network_flag.load(Ordering::Relaxed) {
                return;
            }
            // Bail if superseded between spawn and execution.
            if generation != generation_handle.load(Ordering::Relaxed) {
                return;
            }
            match weather::fetch_fresh(&http, &target, &lang).await {
                Ok(weather) => {
                    // Discard if location/cache/preferences changed during the fetch.
                    if generation != generation_handle.load(Ordering::Relaxed) {
                        return;
                    }
                    // Discard if the stored location no longer matches the target the
                    // fetch used (user picked a new manual location mid-flight).
                    let location_overwritten = store
                        .data
                        .lock()
                        .expect("store mutex poisoned")
                        .location
                        .as_ref()
                        .is_some_and(|current| {
                            (current.latitude, current.longitude)
                                != (target_latitude, target_longitude)
                                || current.source != target_source
                        });
                    if location_overwritten {
                        return;
                    }
                    if store
                        .transaction(|data| {
                            if generation != generation_handle.load(Ordering::Relaxed)
                                || !weather_flag.load(Ordering::Relaxed)
                                || !network_flag.load(Ordering::Relaxed)
                                || !data.location.as_ref().is_some_and(|current| {
                                    current.latitude == target_latitude
                                        && current.longitude == target_longitude
                                        && current.source == target_source
                                })
                            {
                                return Err("Weather refresh cancelled".into());
                            }
                            data.weather = Some(weather.clone());
                            data.weather_failures = 0;
                            data.last_weather_attempt = Some(now);
                            Ok(())
                        })
                        .is_err()
                    {
                        return;
                    }
                    let _ = handle.emit(
                        "weather-refreshed",
                        WeatherReport {
                            data: weather,
                            from_cache: false,
                            stale: false,
                        },
                    );
                }
                Err(_) => {
                    if generation != generation_handle.load(Ordering::Relaxed) {
                        return;
                    }
                    weather::record_failure(&store, now);
                }
            }
        })
    });
    let _ = spawned;
}

#[tauri::command]
pub fn weather_clear_cache(state: State<'_, AppState>) {
    // Cancel any in-flight refresh first so a late success cannot repopulate the
    // cache the user just cleared, then drop the cached data.
    state.weather_task.cancel();
    weather::clear_cache(&state.store);
}
