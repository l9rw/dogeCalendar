use tauri::{Emitter, Listener, Manager};

mod commands;
mod domain;
mod providers;
mod services;
mod state;

use state::AppState;

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    System::Variant::VARIANT,
    UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ClassNamePropertyId,
    },
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, FindWindowW, GetAncestor, GetClassNameW, GetMessageW,
        GetParent, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint,
        GA_ROOT, HC_ACTION, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_RBUTTONDOWN,
    },
};

#[cfg(windows)]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(windows)]
static CLOCK_RECT: Mutex<Option<RECT>> = Mutex::new(None);

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

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid()
        || !matches!(
            class_name(root).as_str(),
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
    {
        return false;
    }

    let mut current = hwnd;
    for _ in 0..8 {
        let name = class_name(current);
        if matches!(name.as_str(), "ClockButton" | "TrayClockWClass") {
            return true;
        }
        current = unsafe { GetParent(current) }.unwrap_or_default();
        if current.is_invalid() {
            break;
        }
    }

    // Win11 exposes the clock as a UIA element, while WindowFromPoint only sees
    // the whole taskbar. The background worker caches the exact clock bounds.
    CLOCK_RECT
        .try_lock()
        .ok()
        .and_then(|rect| *rect)
        .is_some_and(|rect| point_in_rect(point, rect))
}

#[cfg(windows)]
fn point_in_rect(point: POINT, rect: RECT) -> bool {
    point.x >= rect.left
        && point.x < rect.right
        && point.y >= rect.top
        && point.y < rect.bottom
}

#[cfg(all(test, windows))]
#[test]
fn clock_hit_area_excludes_adjacent_tray_controls() {
    let rect = RECT {
        left: 1434,
        top: 869,
        right: 1496,
        bottom: 917,
    };
    assert!(point_in_rect(POINT { x: 1450, y: 890 }, rect));
    assert!(!point_in_rect(POINT { x: 1425, y: 890 }, rect)); // volume
    assert!(!point_in_rect(POINT { x: 1500, y: 890 }, rect)); // show desktop
}

#[cfg(windows)]
fn clock_rect(automation: &IUIAutomation) -> Option<RECT> {
    let taskbar = unsafe { FindWindowW(windows::core::w!("Shell_TrayWnd"), None) }.ok()?;
    let element = unsafe { automation.ElementFromHandle(taskbar) }.ok()?;
    let condition = unsafe {
        automation.CreatePropertyCondition(
            UIA_ClassNamePropertyId,
            &VARIANT::from("SystemTray.OmniButton"),
        )
    }
    .ok()?;
    let clock = unsafe { element.FindFirst(TreeScope_Descendants, &condition) }.ok()?;
    if unsafe { clock.CurrentAutomationId() }.ok()?.to_string() != "SystemTrayIcon" {
        return None;
    }
    let rect = unsafe { clock.CurrentBoundingRectangle() }.ok()?;
    (rect.left < rect.right && rect.top < rect.bottom).then_some(rect)
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
        if let Ok(hook) = hook {
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let _ = unsafe { UnhookWindowsHookEx(hook) };
        }
    });
    std::thread::spawn(|| {
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            return;
        }
        if let Ok(automation) =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
        {
            loop {
                let rect = clock_rect(&automation);
                if let Ok(mut cached) = CLOCK_RECT.lock() {
                    *cached = rect;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
        unsafe { CoUninitialize() };
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

#[tauri::command]
fn open_aux_panel(app: tauri::AppHandle, panel: String, date: Option<String>) -> Result<(), String> {
    let (label, width, height) = match panel.as_str() {
        "detail" => ("detail", 350.0, 600.0),
        "clock" => ("clock", 520.0, 300.0),
        _ => return Err("未知面板".into()),
    };
    let window = app.get_webview_window(label).ok_or("附属窗口不可用")?;
    let main = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let main_pos = main.outer_position().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let main_size = main.outer_size().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let (left, top, right, bottom) = if let Some(monitor) = main.current_monitor().map_err(|error| error.to_string())? {
        let pos = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        (pos.x, pos.y, pos.x + size.width, pos.y + size.height)
    } else {
        (main_pos.x, main_pos.y, main_pos.x + main_size.width, main_pos.y + main_size.height)
    };
    let x = if main_pos.x - width - 12.0 >= left {
        main_pos.x - width - 12.0
    } else {
        main_pos.x + main_size.width + 12.0
    }.clamp(left, (right - width).max(left));
    let y = main_pos.y.clamp(top, (bottom - height).max(top));
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|error| error.to_string())?;
    if label == "detail" {
        if let Some(date) = date {
            app.emit_to(label, "detail-date-changed", date)
                .map_err(|error| error.to_string())?;
        }
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_aux_panel(app: tauri::AppHandle, panel: String) -> Result<(), String> {
    if panel != "detail" && panel != "clock" {
        return Err("未知面板".into());
    }
    if let Some(window) = app.get_webview_window(&panel) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
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
            open_aux_panel,
            close_aux_panel,
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
            fetch_huangli,
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
                    let aux_visible = ["detail", "clock"].iter().any(|label| {
                        window.app_handle()
                            .get_webview_window(label)
                            .is_some_and(|aux| aux.is_visible().unwrap_or(false))
                    });
                    if window.label() == "main" && !aux_visible {
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
