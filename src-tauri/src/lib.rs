use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use chrono::{Datelike, Local};
#[cfg(target_os = "macos")]
use domain::MenuBarStyle;
#[cfg(target_os = "macos")]
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Effect, EffectsBuilder},
};

#[cfg(target_os = "macos")]
static PANEL_FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static MAIN_PANEL_FOCUSED: AtomicBool = AtomicBool::new(false);

mod commands;
mod domain;
mod providers;
mod services;
mod state;
#[cfg(windows)]
mod clock_hover;
#[cfg(windows)]
mod date_format;
#[cfg(windows)]
mod taskbar_clock;

use state::AppState;

#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetClassNameW, GetMessageW, GetParent,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint, GA_ROOT,
        HC_ACTION, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_RBUTTONDOWN,
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

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid() || !taskbar_clock::is_taskbar_class(&class_name(root)) {
        return false;
    }

    let mut current = hwnd;
    for _ in 0..8 {
        let name = class_name(current);
        if matches!(name.as_str(), "TrayClockWClass" | "ClockButton") {
            return true;
        }
        current = unsafe { GetParent(current) }.unwrap_or_default();
        if current.is_invalid() {
            break;
        }
    }

    taskbar_clock::contains(root, point)
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
    let main_hwnd = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as usize);
    let _ = APP_HANDLE.set(app);
    taskbar_clock::start_tracking();
    std::thread::spawn(move || {
        let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) };
        let Ok(hook) = hook else { return };
        if let Some(hwnd) = main_hwnd {
            clock_hover::start(HWND(hwnd as *mut _));
        }
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

fn hide_main_panel(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    MAIN_PANEL_FOCUSED.store(false, Ordering::Relaxed);
    for label in ["main", "detail", "clock"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

fn toggle_calendar_at(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            hide_main_panel(app);
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
            // Other apps' full-screen Spaces cannot be moved into. The popup
            // needs to be present on every Space instead.
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn menu_bar_icon() -> tauri::image::Image<'static> {
    // Draw at 2x the 22pt status-item size to keep the edges sharp on Retina displays.
    let mut pixels = vec![0; 44 * 44 * 4];
    for y in 0..44 {
        for x in 0..44 {
            let outline = (x == 2 || x == 41) && (7..=41).contains(&y)
                || (y == 7 || y == 41 || y == 18) && (2..=41).contains(&x);
            let ring = (y <= 12) && ((10..=13).contains(&x) || (30..=33).contains(&x));
            let date = (23..=35).contains(&y) && ((10..=17).contains(&x) || (26..=33).contains(&x));
            if outline || ring || date {
                let index = (y * 44 + x) * 4;
                pixels[index + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(pixels, 44, 44)
}

#[cfg(target_os = "macos")]
fn menu_bar_date_icon(style: MenuBarStyle) -> tauri::image::Image<'static> {
    use objc2::{runtime::AnyObject, AnyThread};
    use objc2_app_kit::{
        NSBezierPath, NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSGraphicsContext, NSAttributedStringNSStringDrawing,
    };
    use objc2_foundation::{NSAttributedString, NSAttributedStringKey, NSDictionary, NSString};

    let today = Local::now();
    const SIZE: usize = 44;
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), std::ptr::null_mut(), SIZE as isize, SIZE as isize, 8, 4, true, false,
            NSDeviceRGBColorSpace, 0, 0,
        )
    }.expect("failed to create menu bar image");
    let bytes_per_row = rep.bytesPerRow() as usize;
    unsafe { std::slice::from_raw_parts_mut(rep.bitmapData(), bytes_per_row * SIZE) }.fill(0);
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)
        .expect("failed to create menu bar drawing context");
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    NSColor::whiteColor().setFill();
    NSBezierPath::fillRect(objc2_foundation::NSRect::new(
        objc2_foundation::NSPoint::new(1.0, 1.0),
        objc2_foundation::NSSize::new(42.0, 42.0),
    ));

    let draw_line = |text: &str, font_size: f64, bottom: f64| {
        let font = NSFont::boldSystemFontOfSize(font_size);
        let color = NSColor::blackColor();
        let keys: [&NSAttributedStringKey; 2] = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
        let values: [&AnyObject; 2] = [font.as_ref(), color.as_ref()];
        let attributes = NSDictionary::from_slices(&keys, &values);
        let string = NSString::from_str(text);
        let line = unsafe { NSAttributedString::initWithString_attributes(
            NSAttributedString::alloc(), &string, Some(&attributes),
        ) };
        let size = line.size();
        line.drawAtPoint(objc2_foundation::NSPoint::new((SIZE as f64 - size.width) / 2.0, bottom));
    };

    match style {
        MenuBarStyle::Date => draw_line(&today.day().to_string(), 32.0, 2.0),
        MenuBarStyle::WeekdayDate => {
            let weekday = ["日", "一", "二", "三", "四", "五", "六"][today.weekday().num_days_from_sunday() as usize];
            draw_line(&format!("周{weekday}"), 18.0, 22.0);
            draw_line(&today.day().to_string(), 22.0, 0.0);
        }
        MenuBarStyle::Calendar => unreachable!(),
    }

    NSGraphicsContext::restoreGraphicsState_class();
    let mut pixels = vec![0; SIZE * SIZE * 4];
    let bitmap = rep.bitmapData();
    for row in 0..SIZE {
        let source = unsafe { std::slice::from_raw_parts(bitmap.add(row * bytes_per_row), SIZE * 4) };
        pixels[row * SIZE * 4..(row + 1) * SIZE * 4].copy_from_slice(source);
    }
    tauri::image::Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

#[cfg(target_os = "macos")]
fn enlarge_menu_bar_icon(tray: &tauri::tray::TrayIcon) -> tauri::Result<()> {
    use objc2::MainThreadMarker;
    use objc2_foundation::NSSize;

    // tray-icon sets NSImage to 18pt on every update; display the 44px bitmap at 2x.
    tray.with_inner_tray_icon(|inner| {
        let Some(item) = inner.ns_status_item() else { return };
        let Some(button) = item.button(MainThreadMarker::new().expect("menu bar requires main thread")) else { return };
        if let Some(image) = button.image() {
            image.setSize(NSSize::new(22.0, 22.0));
        }
    })
}

#[cfg(target_os = "macos")]
fn update_menu_bar_icon(app: &tauri::AppHandle, style: MenuBarStyle) -> Result<(), String> {
    let tray = app.tray_by_id("calendar-menu-bar").ok_or("菜单栏图标不可用")?;
    let icon = if style == MenuBarStyle::Calendar { menu_bar_icon() } else { menu_bar_date_icon(style) };
    tray.set_icon_with_as_template(Some(icon), style == MenuBarStyle::Calendar)
        .map_err(|error| error.to_string())?;
    enlarge_menu_bar_icon(&tray).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn menu_bar_style_get(state: tauri::State<'_, AppState>) -> MenuBarStyle {
    state.store.data.lock().expect("store mutex poisoned").menu_bar_style
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn menu_bar_style_set(app: tauri::AppHandle, state: tauri::State<'_, AppState>, style: MenuBarStyle) -> Result<(), String> {
    update_menu_bar_icon(&app, style)?;
    state.store.with(|data| data.menu_bar_style = style);
    Ok(())
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
    MAIN_PANEL_FOCUSED.store(false, Ordering::Relaxed);
    if let Err(error) = window.set_position(position) {
        eprintln!("calendar tray: failed to position panel: {error}");
    }
    // Tauri's show() makes the window key, and set_focus() activates our app.
    // Either can switch away from another application's full-screen Space.
    match window.ns_window() {
        Ok(ns_window) => unsafe {
            (*(ns_window as *mut objc2_app_kit::NSWindow)).orderFrontRegardless()
        },
        Err(error) => eprintln!("calendar tray: failed to get native panel: {error}"),
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "calendar tray: show at ({}, {}), visible={:?}, focused={:?}, active_space={:?}",
        position.x,
        position.y,
        window.is_visible(),
        window.is_focused(),
        window.ns_window().map(|ptr| unsafe { (*(ptr as *mut objc2_app_kit::NSWindow)).isOnActiveSpace() })
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
        #[cfg(debug_assertions)]
        let focused = window.is_focused().unwrap_or(false);
        #[cfg(debug_assertions)]
        eprintln!(
            "calendar tray: toggle visible={visible}, active_space={on_active_space}, focused={focused}"
        );
        if visible && on_active_space {
            hide_main_panel(app);
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

    let style = app.state::<AppState>().store.data.lock().expect("store mutex poisoned").menu_bar_style;
    let icon = if style == MenuBarStyle::Calendar { menu_bar_icon() } else { menu_bar_date_icon(style) };
    let tray = TrayIconBuilder::with_id("calendar-menu-bar")
        .icon(icon)
        .icon_as_template(style == MenuBarStyle::Calendar)
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

    let tray = tray.build(app)?;
    enlarge_menu_bar_icon(&tray)?;
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut date = Local::now().date_naive();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let today = Local::now().date_naive();
            if today != date {
                date = today;
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let style = app.state::<AppState>().store.data.lock().expect("store mutex poisoned").menu_bar_style;
                    if style != MenuBarStyle::Calendar {
                        let _ = update_menu_bar_icon(&app, style);
                    }
                });
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn show_update_panel(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    window.center().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_aux_panel(app: tauri::AppHandle, panel: String, date: Option<String>) -> Result<(), String> {
    let (label, title, width) = match panel.as_str() {
        "detail" => ("detail", "日期详情", 350.0),
        "clock" => ("clock", "世界时间", 520.0),
        _ => return Err("未知面板".into()),
    };
    let main = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let main_pos = main.outer_position().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let main_size = main.outer_size().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    let height = if label == "detail" {
        main.inner_size().map_err(|error| error.to_string())?.to_logical::<f64>(scale).height
    } else {
        300.0
    };
    if let Some(window) = app.get_webview_window(label) {
        if label == "detail" {
            if let Some(date) = date {
                app.emit_to(label, "detail-date-changed", date)
                    .map_err(|error| error.to_string())?;
            }
        }
        if !window.is_visible().map_err(|error| error.to_string())? {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

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
        format!("?panel=detail&date={}", date.unwrap_or_default())
    } else {
        "?panel=clock".to_string()
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

fn huangli_split_list(value: &str) -> Vec<String> {
    value
        .split(['.', '，', ',', '、', ' ', '/'])
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn huangli_normalize(json: &serde_json::Value, date: &str, source: &str) -> Option<serde_json::Value> {
    if json["code"].as_i64() != Some(200) || json["data"]["solar"]["full"].as_str() != Some(date) {
        return None;
    }
    let data = &json["data"];
    let yi = data["taboo"]["day"]["recommends"].as_str()?;
    let ji = data["taboo"]["day"]["avoids"].as_str()?;
    if yi.is_empty() && ji.is_empty() {
        return None;
    }
    let ganzhi = ["year", "month", "day"]
        .iter()
        .filter_map(|part| data["sixty_cycle"][*part]["name"].as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Some(serde_json::json!({
        "source": source,
        "lunar": data["lunar"]["desc_short"].as_str().unwrap_or(""),
        "ganzhi": ganzhi,
        "week": data["solar"]["week_desc"].as_str().unwrap_or(""),
        "xingzuo": data["constellation"]["name"].as_str().unwrap_or(""),
        "shengxiao": data["zodiac"]["year"].as_str().unwrap_or(""),
        "festival": data["festival"]["both_desc"].as_str()
            .or_else(|| data["legal_holiday"]["name"].as_str()).unwrap_or(""),
        "jieqi": data["term"]["today"]["name"].as_str().unwrap_or(""),
        "yi": huangli_split_list(yi),
        "ji": huangli_split_list(ji),
        "pengsheng": "",
        "baiji": "",
        "zhushen": "",
        "taishen": "",
    }))
}

fn huangli_request(agent: &ureq::Agent, url: &str, date: &str, source: &str) -> Option<serde_json::Value> {
    let response = agent.get(url).call().ok()?;
    let json: serde_json::Value = response.into_json().ok()?;
    huangli_normalize(&json, date, source)
}

#[tauri::command]
fn fetch_huangli(date: String) -> Result<serde_json::Value, String> {
    let parsed = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|_| "日期格式无效".to_string())?;
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err("日期格式无效".into());
    }
    let agent = ureq::AgentBuilder::new()
        .user_agent("Calendar/0.1.0")
        .timeout(std::time::Duration::from_secs(8))
        .build();

    for (host, source) in [("60s.viki.moe", "60s"), ("60s.7se.cn", "60s mirror")] {
        let url = format!("https://{host}/v2/lunar?date={date}");
        if let Some(data) = huangli_request(&agent, &url, &date, source) {
            return Ok(data);
        }
    }

    Err(format!("黄历接口暂时不可用: {}", date))
}

#[cfg(test)]
mod huangli_tests {
    use super::*;

    #[test]
    fn maps_60s_daily_data() {
        let json = serde_json::json!({
            "code": 200,
            "data": {
                "solar": { "full": "2026-09-27", "week_desc": "星期日" },
                "lunar": { "desc_short": "农历丙午年八月十七" },
                "sixty_cycle": { "year": { "name": "丙午年" }, "month": { "name": "丁酉月" }, "day": { "name": "甲辰日" } },
                "taboo": { "day": { "recommends": "嫁娶.纳采", "avoids": "开市.安葬" } }
            }
        });
        let result = huangli_normalize(&json, "2026-09-27", "60s").unwrap();
        assert_eq!(result["yi"], serde_json::json!(["嫁娶", "纳采"]));
        assert_eq!(result["ji"], serde_json::json!(["开市", "安葬"]));
        assert_eq!(result["ganzhi"], "丙午年 丁酉月 甲辰日");
        assert_eq!(result["lunar"], "农历丙午年八月十七");
        assert_eq!(result["source"], "60s");
    }

    #[test]
    fn rejects_failed_or_wrong_date_responses() {
        let json = serde_json::json!({
            "code": 200,
            "data": { "solar": { "full": "2026-03-02" }, "taboo": { "day": { "recommends": "祭祀", "avoids": "出行" } } }
        });
        assert!(huangli_normalize(&json, "2026-02-30", "60s").is_none());
        assert!(huangli_normalize(&serde_json::json!({ "code": 429, "data": json["data"] }), "2026-03-02", "60s").is_none());
        assert!(huangli_normalize(&serde_json::json!({
            "code": 200,
            "data": { "solar": { "full": "2026-03-02" }, "taboo": { "day": { "recommends": "", "avoids": "" } } }
        }), "2026-03-02", "60s").is_none());
    }

    #[test]
    fn rejects_invalid_dates_before_request() {
        assert!(fetch_huangli("2026-02-30".into()).is_err());
        assert!(fetch_huangli("2026-9-27".into()).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            date_format::taskbar_date_format_get,
            #[cfg(windows)]
            date_format::taskbar_date_format_preview,
            #[cfg(windows)]
            date_format::taskbar_date_format_set,
            #[cfg(target_os = "macos")]
            menu_bar_style_get,
            #[cfg(target_os = "macos")]
            menu_bar_style_set,
            quit_app,
            show_update_panel,
            commands::update::check_for_updates,
            commands::autostart::autostart_get,
            commands::autostart::autostart_set,
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
                window.set_title("dogeCalendar")?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if window.label() == "main" {
                        hide_main_panel(window.app_handle());
                    } else {
                        let _ = window.hide();
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                    MAIN_PANEL_FOCUSED.store(true, Ordering::Relaxed);
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
                                        if MAIN_PANEL_FOCUSED.load(Ordering::Relaxed)
                                            && !main.is_focused().unwrap_or(false) {
                                            #[cfg(debug_assertions)]
                                            eprintln!("calendar tray: hiding unfocused main panel");
                                            hide_main_panel(window.app_handle());
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
                        if window.label() == "main" {
                            hide_main_panel(window.app_handle());
                        } else {
                            let _ = window.hide();
                        }
                    }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
