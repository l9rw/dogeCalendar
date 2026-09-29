use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

#[cfg(target_os = "macos")]
#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
fn macos_service() -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2::{class, msg_send};
    use objc2_foundation::NSProcessInfo;

    if NSProcessInfo::processInfo().operatingSystemVersion().majorVersion < 13
        || !std::env::current_exe()
            .ok()?
            .to_string_lossy()
            .contains(".app/Contents/MacOS/")
    {
        return None;
    }

    Some(unsafe { msg_send![class!(SMAppService), mainAppService] })
}

#[cfg(target_os = "macos")]
fn macos_enabled(service: &objc2::runtime::AnyObject) -> bool {
    let status: isize = unsafe { objc2::msg_send![service, status] };
    status == 1 // SMAppServiceStatusEnabled
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(service) = macos_service() {
        return macos_enabled(&service);
    }

    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    if let Some(service) = macos_service() {
        use objc2::{msg_send, rc::Retained};
        use objc2_foundation::NSError;

        let status: isize = unsafe { msg_send![&service, status] };
        if enabled && status != 1 {
            let result: Result<(), Retained<NSError>> =
                unsafe { msg_send![&service, registerAndReturnError: _] };
            result.map_err(|error| error.localizedDescription().to_string())?;
        } else if !enabled && status != 0 {
            let result: Result<(), Retained<NSError>> =
                unsafe { msg_send![&service, unregisterAndReturnError: _] };
            result.map_err(|error| error.localizedDescription().to_string())?;
        }

        // The old plugin only checked whether this plist exists, not whether launchd loaded it.
        app.autolaunch()
            .disable()
            .map_err(|error| error.to_string())?;
        return Ok(macos_enabled(&service));
    }

    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result
        .map(|_| manager.is_enabled().unwrap_or(enabled))
        .map_err(|error| error.to_string())
}
