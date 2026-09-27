use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Effect, EffectsBuilder},
};

#[cfg(target_os = "macos")]
static PANEL_FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);

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

#[cfg(target_os = "macos")]
fn configure_macos_panel(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};

    window.set_effects(
        EffectsBuilder::new()
            .effect(Effect::Menu)
            .radius(16.0)
            .build(),
    )?;
    window.set_shadow(true)?;
    let ns_window = window.ns_window()? as *mut NSWindow;
    // The window is created by Tauri; AppKit settings make it behave as a transient menu panel.
    unsafe {
        // Full-screen apps cover floating windows; menu popups must sit above them.
        (*ns_window).setLevel(NSPopUpMenuWindowLevel);
        // Focus-loss handling below dismisses the panel without AppKit hiding it
        // during the activation change from the full-screen application.
        (*ns_window).setHidesOnDeactivate(false);
        (*ns_window).setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn menu_bar_icon() -> tauri::image::Image<'static> {
    // A monochrome 18pt calendar at 2x, with transparent pixels for AppKit's template tint.
    let mut pixels = vec![0; 36 * 36 * 4];
    for y in 0..36 {
        for x in 0..36 {
            let outline = (x == 5 || x == 30) && (8..=31).contains(&y)
                || (y == 8 || y == 31 || y == 16) && (5..=30).contains(&x);
            let ring = (y >= 4 && y <= 11) && ((10..=12).contains(&x) || (23..=25).contains(&x));
            let date = (20..=26).contains(&y) && ((10..=14).contains(&x) || (19..=23).contains(&x));
            if outline || ring || date {
                let index = (y * 36 + x) * 4;
                pixels[index + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(pixels, 36, 36)
}

#[cfg(target_os = "macos")]
fn show_calendar_below_tray(app: &tauri::AppHandle, rect: tauri::Rect) {
    let Some(window) = app.get_webview_window("main") else {
        #[cfg(debug_assertions)]
        eprintln!("calendar tray: main window missing");
        return;
    };
    let Ok(size) = window.outer_size() else {
        #[cfg(debug_assertions)]
        eprintln!("calendar tray: failed to read main window size");
        return;
    };

    // The tray reports physical coordinates in its screen's scale, not the window's scale.
    let monitor = app.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|monitor| {
            let scale = monitor.scale_factor();
            let point = rect.position.to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            let size = monitor.size().to_logical::<f64>(scale);
            point.x >= origin.x
                && point.x < origin.x + size.width
                && point.y >= origin.y
                && point.y < origin.y + size.height
        })
    });
    let scale = monitor.as_ref().map_or_else(
        || window.scale_factor().unwrap_or(1.0),
        |m| m.scale_factor(),
    );
    let tray_position = rect.position.to_logical::<f64>(scale);
    let tray_size = rect.size.to_logical::<f64>(scale);
    let window_scale = window.scale_factor().unwrap_or(1.0);
    let window_size = size.to_logical::<f64>(window_scale);
    let mut x = tray_position.x + (tray_size.width - window_size.width) / 2.0;
    let mut y = tray_position.y + tray_size.height + 6.0;

    if let Some(monitor) = monitor {
        // Tauri's macOS work area comes from NSScreen.visibleFrame.
        let work_area = monitor.work_area();
        let origin = work_area.position.to_logical::<f64>(scale);
        let size = work_area.size.to_logical::<f64>(scale);
        x = x.clamp(
            origin.x,
            (origin.x + size.width - window_size.width).max(origin.x),
        );
        y = y.clamp(
            origin.y,
            (origin.y + size.height - window_size.height).max(origin.y),
        );
    }

    let position = tauri::LogicalPosition::new(x.round(), y.round());
    if let Err(error) = window.set_position(position) {
        eprintln!("calendar tray: failed to position panel: {error}");
    }
    if let Err(error) = window.show() {
        eprintln!("calendar tray: failed to show panel: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("calendar tray: failed to focus panel: {error}");
    }
    // A window left on another Space may still be "visible" to Tauri. Bring it
    // above the current full-screen Space after activating the app.
    if let Ok(ns_window) = window.ns_window() {
        unsafe { (*(ns_window as *mut objc2_app_kit::NSWindow)).orderFrontRegardless() };
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "calendar tray: show at ({}, {}), visible={:?}, focused={:?}",
        position.x,
        position.y,
        window.is_visible(),
        window.is_focused()
    );
}

#[cfg(target_os = "macos")]
fn toggle_calendar_below_tray(app: &tauri::AppHandle, rect: tauri::Rect) {
    PANEL_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let on_active_space = window
            .ns_window()
            .map(|ns_window| unsafe {
                (*(ns_window as *mut objc2_app_kit::NSWindow)).isOnActiveSpace()
            })
            .unwrap_or(false);
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        #[cfg(debug_assertions)]
        eprintln!(
            "calendar tray: toggle visible={visible}, active_space={on_active_space}, focused={focused}"
        );
        if visible && on_active_space && focused {
            let _ = window.hide();
        } else {
            show_calendar_below_tray(app, rect);
        }
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_menu_bar(app: &mut tauri::App) -> tauri::Result<()> {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    if let Some(window) = app.get_webview_window("main") {
        configure_macos_panel(&window)?;
    }

    let tray = TrayIconBuilder::with_id("calendar-menu-bar")
        .icon(menu_bar_icon())
        .icon_as_template(true)
        .tooltip("日历")
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button,
                button_state,
                ..
            } = event
            {
                #[cfg(debug_assertions)]
                eprintln!("calendar tray: {button:?} {button_state:?}");
                // Full-screen menu bars can retreat before mouse-up reaches the status item.
                if button_state == MouseButtonState::Down {
                    let app = tray.app_handle();
                    match button {
                        MouseButton::Left => {
                            toggle_calendar_below_tray(app, rect);
                            let _ = app.emit("taskbar-calendar-click", ());
                        }
                        MouseButton::Right => {
                            PANEL_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed);
                            show_calendar_below_tray(app, rect);
                            let _ = app.emit("taskbar-calendar-context", ());
                        }
                        _ => {}
                    }
                }
            }
        });

    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_aux_panel(app: tauri::AppHandle, panel: String, date: Option<String>) -> Result<(), String> {
    let (label, title, width, height) = match panel.as_str() {
        "detail" => ("detail", "日期详情", 350.0, 600.0),
        "clock" => ("clock", "世界时间", 520.0, 300.0),
        _ => return Err("未知面板".into()),
    };
    if let Some(window) = app.get_webview_window(label) {
        if label == "detail" {
            if let Some(date) = date {
                app.emit_to(label, "detail-date-changed", date)
                    .map_err(|error| error.to_string())?;
            }
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let main = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let main_pos = main.outer_position().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let main_size = main.outer_size().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let (left, top, right, bottom) = if let Some(monitor) = main.current_monitor().map_err(|error| error.to_string())? {
        #[cfg(target_os = "macos")]
        let (position, size) = (monitor.work_area().position, monitor.work_area().size);
        #[cfg(not(target_os = "macos"))]
        let (position, size) = (*monitor.position(), *monitor.size());
        #[cfg(target_os = "macos")]
        let scale = monitor.scale_factor();
        let pos = position.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
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
    let url = if label == "detail" {
        format!("index.html?panel=detail&date={}", date.unwrap_or_default())
    } else {
        "index.html?panel=clock".to_string()
    };
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .build()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    configure_macos_panel(&window).map_err(|error| error.to_string())?;
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

            #[cfg(target_os = "macos")]
            setup_macos_menu_bar(app)?;

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
                    #[cfg(target_os = "macos")]
                    {
                        #[cfg(debug_assertions)]
                        eprintln!("calendar tray: {} lost focus", window.label());
                        let generation = PANEL_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
                        let window = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(120));
                            let app = window.app_handle().clone();
                            let _ = app.run_on_main_thread(move || {
                                if PANEL_FOCUS_GENERATION.load(Ordering::Relaxed) != generation {
                                    return;
                                }
                                let main = window.app_handle().get_webview_window("main");
                                let aux_focused = ["detail", "clock"].iter().any(|label| {
                                    window
                                        .app_handle()
                                        .get_webview_window(label)
                                        .is_some_and(|aux| aux.is_focused().unwrap_or(false))
                                });
                                if window.label() != "main" && !window.is_focused().unwrap_or(false) {
                                    #[cfg(debug_assertions)]
                                    eprintln!("calendar tray: hiding unfocused {} panel", window.label());
                                    let _ = window.hide();
                                }
                                if !aux_focused {
                                    if let Some(main) = main {
                                        if !main.is_focused().unwrap_or(false) {
                                            #[cfg(debug_assertions)]
                                            eprintln!("calendar tray: hiding unfocused main panel");
                                            let _ = main.hide();
                                        }
                                    }
                                }
                            });
                        });
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                    let aux_visible = ["detail", "clock"].iter().any(|label| {
                        window.app_handle().get_webview_window(label)
                            .is_some_and(|aux| aux.is_visible().unwrap_or(false))
                    });
                    if window.label() != "main" || !aux_visible {
                        let _ = window.hide();
                    }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
