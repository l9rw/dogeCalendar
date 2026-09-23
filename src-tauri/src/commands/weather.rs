use tauri::State;

use crate::domain::WeatherReport;
use crate::services::weather;
use crate::state::AppState;

#[tauri::command]
pub async fn weather_get(state: State<'_, AppState>) -> Result<WeatherReport, String> {
    weather::get_weather(&state.http, &state.store).await
}

#[tauri::command]
pub fn weather_clear_cache(state: State<'_, AppState>) {
    weather::clear_cache(&state.store);
}
