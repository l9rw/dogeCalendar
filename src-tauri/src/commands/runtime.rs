use tauri::State;

use crate::domain::RuntimePreferences;
use crate::state::AppState;
use crate::services::store::StoreHealth;

#[tauri::command]
pub fn storage_health_get(state: State<'_, AppState>) -> StoreHealth {
    state.store.health()
}

#[tauri::command]
pub fn runtime_preferences_get(state: State<'_, AppState>) -> RuntimePreferences {
    RuntimePreferences {
        weather_enabled: state.weather_enabled(),
        network_enabled: state.network_enabled(),
    }
}

#[tauri::command]
pub fn runtime_preferences_set(
    state: State<'_, AppState>,
    weather_enabled: bool,
    network_enabled: bool,
) -> Result<RuntimePreferences, String> {
    state.set_runtime_preferences(weather_enabled, network_enabled);
    Ok(RuntimePreferences {
        weather_enabled,
        network_enabled,
    })
}
