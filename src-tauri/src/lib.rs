use tauri::{Emitter, Listener, Manager};

mod commands;
mod domain;
mod providers;
mod services;
mod state;

use state::AppState;

#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetClassNameW, GetMessageW, GetParent,
        GetWindowRect, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint,
        GA_ROOT, HC_ACTION, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_RBUTTONDOWN,
    },
};

#[cfg(windows)]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(windows)]
fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length as usize])
}

#[cfg(windows)]
fn is_taskbar_clock(point: POINT) -> bool {
    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd.is_invalid() {
        return false;
    }

    let mut current = hwnd;
    for _ in 0..8 {
        let name = class_name(current);
        if name.contains("Clock") || name.contains("DateTime") || name == "TrayClockWClass" {
            return true;
        }
        current = unsafe { GetParent(current) }.unwrap_or_default();
        if current.is_invalid() {
            break;
        }
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid() || class_name(root) != "Shell_TrayWnd" {
        return false;
    }

    let mut rect = windows::Win32::Foundation::RECT::default();
    if unsafe { GetWindowRect(root, &mut rect) }.is_err() {
        return false;
    }

    // Explorer does not expose a stable clock control class across Windows versions.
    // Limit the fallback hit area to the taskbar's clock-side edge instead of the
    // complete taskbar, so notification and system-tray clicks remain untouched.
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let near_bottom = point.y >= rect.bottom - 80 && point.x >= rect.right - 220;
    let near_top = point.y <= rect.top + 80 && point.x >= rect.right - 220;
    let near_right = point.x >= rect.right - 80 && point.y >= rect.bottom - 220;
    let near_left = point.x <= rect.left + 80 && point.y >= rect.bottom - 220;
    (width > height && (near_bottom || near_top)) || (height >= width && (near_right || near_left))
}

#[cfg(windows)]
unsafe extern "system" fn mouse_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && (message.0 == WM_LBUTTONDOWN as usize || message.0 == WM_RBUTTONDOWN as usize)
    {
        let mouse = *(data.0 as *const MSLLHOOKSTRUCT);
        if is_taskbar_clock(mouse.pt) {
            if let Some(app) = APP_HANDLE.get() {
                let event = if message.0 == WM_LBUTTONDOWN as usize {
                    "taskbar-calendar-click"
                } else {
                    "taskbar-calendar-context"
                };
                let _ = app.emit(
                    event,
                    serde_json::json!({ "x": mouse.pt.x, "y": mouse.pt.y }),
                );
            }
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, message, data)
}

#[cfg(windows)]
fn start_mouse_hook(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
    std::thread::spawn(|| {
        let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) };
        let Ok(hook) = hook else { return };
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    });
}

#[cfg(windows)]
fn work_area_anchor(x: i32, y: i32) -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    let monitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        let _ = GetMonitorInfoW(monitor, &mut info);
    }
    (info.rcWork.right, info.rcWork.bottom)
}

#[cfg(not(windows))]
fn work_area_anchor(x: i32, y: i32) -> (i32, i32) {
    (x, y)
}

fn show_calendar_at(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(window) = app.get_webview_window("main") {
        let size = window.outer_size().unwrap_or_default();
        let (anchor_x, anchor_y) = work_area_anchor(x, y);
        let pos = tauri::PhysicalPosition::new(
            anchor_x - size.width as i32 - 8,
            anchor_y - size.height as i32 - 4,
        );
        let _ = window.set_position(pos);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_calendar_at(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_calendar_at(app, x, y);
        }
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn huangli_pick<'a>(obj: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(value) = obj.get(*key).and_then(|v| v.as_str()) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn huangli_split_list(value: &str) -> Vec<String> {
    value
        .split(['，', ',', '、', ' ', '/'])
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn huangli_normalize(data: &serde_json::Value, source: &str) -> serde_json::Value {
    let yi = huangli_pick(data, &["y", "yi", "suit", "宜"]).unwrap_or("");
    let ji = huangli_pick(data, &["j", "ji", "avoid", "忌"]).unwrap_or("");
    serde_json::json!({
        "source": source,
        "lunar": huangli_pick(data, &["lunar", "nongli", "lunarCalendar"]).unwrap_or(""),
        "ganzhi": huangli_pick(data, &["luna", "ganzhi", "ganZhi", "lunarGanZhi"]).unwrap_or(""),
        "week": huangli_pick(data, &["week", "weekday", "weeks"]).unwrap_or(""),
        "xingzuo": huangli_pick(data, &["xingzuo", "star", "constellation"]).unwrap_or(""),
        "shengxiao": huangli_pick(data, &["shengxiao", "zodiac", "animals"]).unwrap_or(""),
        "festival": huangli_pick(data, &["jieri", "festival", "holiday"]).unwrap_or(""),
        "jieqi": huangli_pick(data, &["suicide", "jieqi", "solarTerm", "jq"]).unwrap_or(""),
        "yi": huangli_split_list(yi),
        "ji": huangli_split_list(ji),
        "pengsheng": huangli_pick(data, &["pengsheng", "pengzu", "pz"]).unwrap_or(""),
        "baiji": huangli_pick(data, &["baiji", "bj"]).unwrap_or(""),
        "zhushen": huangli_pick(data, &["zhushen", "zh", "valueGod"]).unwrap_or(""),
        "taishen": huangli_pick(data, &["taishen", "ts", "fetalGod"]).unwrap_or(""),
    })
}

fn huangli_request(agent: &ureq::Agent, url: &str) -> Option<serde_json::Value> {
    let response = agent.get(url).call().ok()?;
    let json: serde_json::Value = response.into_json().ok()?;
    if let Some(data) = json.get("data") {
        if data.is_object() {
            return Some(data.clone());
        }
    }
    if json.is_object() && (json.get("y").is_some() || json.get("yi").is_some() || json.get("j").is_some()) {
        return Some(json);
    }
    None
}

#[tauri::command]
fn fetch_huangli(date: String) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .user_agent("Calendar/0.1.0")
        .timeout(std::time::Duration::from_secs(8))
        .build();

    let vvhan = format!("https://api.vvhan.com/api/huangli/date?date={}", date);
    if let Some(data) = huangli_request(&agent, &vvhan) {
        return Ok(huangli_normalize(&data, "vvhan"));
    }

    let oioweb = format!("https://api.oioweb.cn/api/common/huangli?date={}", date);
    if let Some(data) = huangli_request(&agent, &oioweb) {
        return Ok(huangli_normalize(&data, "oioweb"));
    }

    Err(format!("黄历接口暂时不可用: {}", date))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            quit_app,
            commands::world_time::world_time_list_cities,
            commands::world_time::world_time_search,
            commands::world_time::world_time_clocks,
            commands::world_time::world_time_use_24_hour,
            commands::world_time::world_time_set_use_24_hour,
            commands::world_time::world_time_add,
            commands::world_time::world_time_remove,
            commands::world_time::world_time_reorder,
            commands::location::location_get,
            commands::location::location_set_manual,
            commands::location::location_clear,
            commands::weather::weather_get,
            commands::weather::weather_clear_cache,
        ])
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("calendar-desktop"));
            app.manage(AppState::new(dir));

            #[cfg(windows)]
            start_mouse_hook(app.handle().clone());

            let handle = app.handle().clone();
            app.listen("taskbar-calendar-click", move |event| {
                let Ok(position) = serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let Some(x) = position.get("x").and_then(|value| value.as_i64()) else {
                    return;
                };
                let Some(y) = position.get("y").and_then(|value| value.as_i64()) else {
                    return;
                };
                toggle_calendar_at(&handle, x as i32, y as i32);
            });

            let handle = app.handle().clone();
            app.listen("taskbar-calendar-context", move |event| {
                let Ok(position) = serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };
                let Some(x) = position.get("x").and_then(|value| value.as_i64()) else {
                    return;
                };
                let Some(y) = position.get("y").and_then(|value| value.as_i64()) else {
                    return;
                };
                show_calendar_at(&handle, x as i32, y as i32);
            });

            #[cfg(debug_assertions)]
            {
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");
                window.set_title("Calendar")?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Focused(false) => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
