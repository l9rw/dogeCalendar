use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result
        .map(|_| manager.is_enabled().unwrap_or(enabled))
        .map_err(|error| error.to_string())
}
