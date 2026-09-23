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
    match location::resolve_location(&state.http, None).await {
        Ok(resolved) => {
            state.store.with(|data| data.location = Some(resolved.clone()));
            Ok(Some(resolved))
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub fn location_set_manual(
    state: State<'_, AppState>,
    latitude: f64,
    longitude: f64,
    label: String,
) -> StoredLocation {
    let location = location::manual(latitude, longitude, label);
    state.store.with(|data| {
        data.location = Some(location.clone());
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
    });
    location
}

#[tauri::command]
pub fn location_clear(state: State<'_, AppState>) {
    state.store.with(|data| {
        data.location = None;
        data.weather = None;
        data.weather_failures = 0;
        data.last_weather_attempt = None;
    });
}
