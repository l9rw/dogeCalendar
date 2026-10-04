use serde::{Deserialize, Serialize};
use tauri::State;

use crate::domain::StoredLocation;
use crate::services::location;
use crate::state::AppState;

#[tauri::command]
pub async fn location_get(state: State<'_, AppState>) -> Result<Option<StoredLocation>, String> {
    let manual = {
        let data = state.store.data.lock().expect("store mutex poisoned");
        data.location.clone()
    };
    if manual.is_some() {
        return Ok(manual);
    }
    // IP geolocation requires network; the weather module owns that lookup, so a
    // disabled weather or network flag blocks IP resolution. Returning None keeps
    // the local clock and manual location flow working without any request.
    if !state.weather_enabled() || !state.network_enabled() {
        return Ok(None);
    }
    let generation = state.weather_task.generation();
    let cancel = state.weather_task.cancel_notify();
    let resolved = tokio::select! {
        result = location::resolve_location(&state.http, None) => result,
        _ = cancel.notified() => return Ok(None),
    };
    if generation != state.weather_task.generation()
        || !state.weather_enabled()
        || !state.network_enabled()
    {
        return Ok(state
            .store
            .data
            .lock()
            .map_err(|error| error.to_string())?
            .location
            .clone());
    }
    match resolved {
        Ok(resolved) => state.store.transaction(|data| {
            if generation == state.weather_task.generation()
                && state.network_enabled()
                && state.weather_enabled()
                && data.location.is_none()
            {
                data.location = Some(resolved);
            }
            Ok(data.location.clone())
        }),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn location_set_manual(
    state: State<'_, AppState>,
    latitude: f64,
    longitude: f64,
    label: String,
) -> Result<StoredLocation, String> {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || latitude.abs() > 90.0
        || longitude.abs() > 180.0
        || label.chars().count() > 120
    {
        return Err("Invalid location coordinates or label".into());
    }
    // A new manual location supersedes any in-flight refresh for the old
    // coordinates; cancel it so a late result cannot overwrite this selection.
    state.weather_task.cancel();
    let location = location::manual(latitude, longitude, label);
    state.store.transaction(|data| {
        data.location = Some(location.clone());
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
        Ok(())
    })?;
    Ok(location)
}

#[tauri::command]
pub fn location_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.weather_task.cancel();
    state.store.transaction(|data| {
        data.location = None;
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
        Ok(())
    })
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LocationCandidate {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub country: Option<String>,
    pub admin1: Option<String>,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<LocationCandidate>,
}

#[tauri::command]
pub async fn location_search(
    state: State<'_, AppState>,
    query: String,
    language: Option<String>,
) -> Result<Vec<LocationCandidate>, String> {
    if !state.network_enabled() || !state.weather_enabled() {
        return Err("Network or weather is disabled".into());
    }
    let query = query.trim();
    if !(2..=100).contains(&query.chars().count()) {
        return Ok(Vec::new());
    }
    let language = if language.as_deref().unwrap_or("en").starts_with("zh") {
        "zh"
    } else {
        "en"
    };
    let cancel = state.weather_task.cancel_notify();
    let generation = state.weather_task.generation();
    let request = async {
        state
            .http
            .get("https://geocoding-api.open-meteo.com/v1/search")
            .query(&[
                ("name", query),
                ("count", "8"),
                ("language", language),
                ("format", "json"),
            ])
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json::<SearchResponse>()
            .await
            .map_err(|error| error.to_string())
    };
    let response = tokio::select! {
        result = request => result?,
        _ = cancel.notified() => return Err("Location search cancelled".into()),
    };
    if generation != state.weather_task.generation()
        || !state.network_enabled()
        || !state.weather_enabled()
    {
        return Err("Location search cancelled".into());
    }
    Ok(response
        .results
        .into_iter()
        .filter(|place| {
            place.latitude.is_finite()
                && place.longitude.is_finite()
                && place.latitude.abs() <= 90.0
                && place.longitude.abs() <= 180.0
        })
        .take(8)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::SearchResponse;

    #[test]
    fn location_search_decodes_optional_fields_and_empty_results() {
        let empty: SearchResponse = serde_json::from_str("{}").unwrap();
        assert!(empty.results.is_empty());
        let city: SearchResponse = serde_json::from_str(
            r#"{"results":[{"name":"Berlin","latitude":52.5,"longitude":13.4}]}"#,
        )
        .unwrap();
        assert_eq!(city.results[0].name, "Berlin");
        assert!(city.results[0].country.is_none());
    }
}
