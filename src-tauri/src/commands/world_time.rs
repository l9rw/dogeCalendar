use tauri::State;

use crate::domain::{WorldClockConfig, WorldClockSnapshot};
use crate::services::world_time;
use crate::state::AppState;

#[tauri::command]
pub fn world_time_list_cities() -> Vec<crate::domain::City> {
    world_time::list_cities()
}

#[tauri::command]
pub fn world_time_search(query: String) -> Vec<crate::domain::City> {
    world_time::search_cities(&query)
}

#[tauri::command]
pub fn world_time_clocks(state: State<'_, AppState>) -> Vec<WorldClockSnapshot> {
    let configs: Vec<WorldClockConfig> = {
        let data = state.store.data.lock().expect("store mutex poisoned");
        if data.world_clocks.is_empty() {
            world_time::default_clocks()
        } else {
            data.world_clocks.clone()
        }
    };
    world_time::snapshots(&configs)
}

#[tauri::command]
pub fn world_time_use_24_hour(state: State<'_, AppState>) -> bool {
    state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .use_24_hour
}

#[tauri::command]
pub fn world_time_set_use_24_hour(state: State<'_, AppState>, enabled: bool) {
    state.store.with(|data| data.use_24_hour = enabled);
}

#[tauri::command]
pub fn world_time_add(state: State<'_, AppState>, label: String, timezone: String) {
    state.store.with(|data| {
        if data.world_clocks.iter().any(|c| c.timezone == timezone) {
            return;
        }
        data.world_clocks.push(WorldClockConfig { label, timezone });
    });
}

#[tauri::command]
pub fn world_time_remove(state: State<'_, AppState>, timezone: String) {
    state.store.with(|data| {
        data.world_clocks.retain(|c| c.timezone != timezone);
    });
}

#[tauri::command]
pub fn world_time_reorder(state: State<'_, AppState>, timezones: Vec<String>) {
    state.store.with(|data| {
        let mut reordered = Vec::new();
        for tz in &timezones {
            if let Some(config) = data.world_clocks.iter().find(|c| &c.timezone == tz).cloned() {
                reordered.push(config);
            }
        }
        for config in data.world_clocks.clone() {
            if !timezones.contains(&config.timezone) {
                reordered.push(config);
            }
        }
        data.world_clocks = reordered;
    });
}
