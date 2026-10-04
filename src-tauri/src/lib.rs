use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(windows)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg(target_os = "macos")]
use chrono::{Datelike, Local};
#[cfg(target_os = "macos")]
use domain::MenuBarStyle;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU64;
#[cfg(windows)]
use std::sync::atomic::AtomicU64;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Effect, EffectsBuilder},
};

#[cfg(target_os = "macos")]
static PANEL_FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static MAIN_PANEL_FOCUSED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static WINDOWS_FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);
// Mirrors the persisted `taskbar_clock_takeover_enabled` flag so the mouse
// hook and clock tracking can read it without locking the store mutex. When
// false the hook passes clicks to the OS clock and the hover overlay clears.
#[cfg(windows)]
static TAKEOVER_ENABLED: AtomicBool = AtomicBool::new(true);

// Default global wake shortcut. `CmdOrCtrl` resolves to Cmd on macOS and Ctrl
// elsewhere, so a single accelerator covers both platforms.
const GLOBAL_SHORTCUT: &str = "CmdOrCtrl+Shift+D";
// A held accelerator toggles once, including platforms with key-repeat events.
static GLOBAL_SHORTCUT_HELD: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod clock_hover;
mod commands;
#[cfg(windows)]
mod date_format;
mod domain;
mod providers;
mod services;
mod state;
#[cfg(windows)]
mod taskbar_clock;

use state::AppState;

use domain::GlobalShortcutConfig;

#[cfg(windows)]
use std::sync::{Mutex, OnceLock};
#[cfg(windows)]
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetClassNameW, GetCursorPos, GetMessageW,
        GetParent, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WindowFromPoint,
        GA_ROOT, HC_ACTION, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_RBUTTONDOWN,
    },
};

#[cfg(windows)]
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(windows)]
static SYSTEM_CLOCK_POINT: Mutex<POINT> = Mutex::new(POINT { x: 0, y: 0 });
#[cfg(windows)]
static SYSTEM_CLOCK_ACTIVE: Mutex<Option<(POINT, std::thread::JoinHandle<bool>)>> =
    Mutex::new(None);

#[cfg(windows)]
fn close_system_clock(clock_point: POINT, opened: std::thread::JoinHandle<bool>) {
    // The menu action may still be opening the native panel when the next click arrives.
    if opened.join().unwrap_or(false) {
        if let Err(error) = taskbar_clock::open_system_clock(clock_point) {
            eprintln!("calendar: failed to close system clock: {error}");
        }
    }
}

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
    // Takeover disabled: never intercept the clock, let the OS handle it.
    let takeover = TAKEOVER_ENABLED.load(Ordering::Relaxed);
    if code == HC_ACTION as i32
        && takeover
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
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
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

#[cfg(windows)]
fn show_windows_context_menu(app: &tauri::AppHandle, x: i32, y: i32) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    hide_main_panel(app);
    let size = window.outer_size()?;
    let (anchor_x, anchor_y) = work_area_anchor(x, y);
    window.set_position(tauri::PhysicalPosition::new(
        anchor_x - size.width as i32 - 8,
        anchor_y - size.height as i32 - 4,
    ))?;
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "system-clock", "打开系统时间", true, None::<&str>)?,
            &MenuItem::with_id(app, "system-date-time", "调整系统时间", true, None::<&str>)?,
            &MenuItem::with_id(app, "system-notifications", "通知设置", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open-calendar", "打开日历", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?,
            &MenuItem::with_id(app, "online-update", "在线更新", true, None::<&str>)?,
            &MenuItem::with_id(app, "about", "关于", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    *SYSTEM_CLOCK_POINT
        .lock()
        .expect("clock point mutex poisoned") = POINT { x, y };
    let mut point = POINT { x, y };
    if !unsafe { ScreenToClient(window.hwnd()?, &mut point) }.as_bool() {
        return window.popup_menu(&menu);
    }
    let scale = window.scale_factor()?;
    window.popup_menu_at(
        &menu,
        tauri::LogicalPosition::new(point.x as f64 / scale, point.y as f64 / scale),
    )
}

#[cfg(windows)]
fn build_windows_fallback_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Standalone tray icon that lets users reach the calendar even when the
    // taskbar-clock interception is unavailable or flaky. It coexists with the
    // mouse hook; left-click toggles the panel at the cursor, right-click opens
    // the same native menu used by the taskbar entry.
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open-calendar", "打开日历", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?,
            &MenuItem::with_id(app, "online-update", "在线更新", true, None::<&str>)?,
            &MenuItem::with_id(app, "about", "关于", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("calendar-fallback-tray")
        .tooltip("日历")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                let runner = app.clone();
                let _ = runner.run_on_main_thread(move || {
                    let mut cursor = POINT::default();
                    let (x, y) = if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
                        (cursor.x, cursor.y)
                    } else {
                        (0, 0)
                    };
                    toggle_calendar_at(&app, x, y);
                });
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(windows)]
fn apply_windows_fallback_tray(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let enabled = state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .fallback_tray_enabled;
    if let Some(tray) = app.tray_by_id("calendar-fallback-tray") {
        // set_visible surfaces a creation/display error instead of swallowing it;
        // a missing tray would otherwise leave the app with no mouse entry.
        tray.set_visible(enabled)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if enabled {
        build_windows_fallback_tray(app).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// True when no Windows entry would remain reachable. The takeover flag is
/// trusted (the hook itself cannot be probed from an IPC handler), but the
/// fallback tray is only counted when it is actually built and visible, and
/// the global shortcut only when it is registered without a conflict error.
#[cfg(windows)]
fn no_entry_available(takeover: bool, fallback: bool, shortcut: bool) -> bool {
    !takeover && !fallback && !shortcut
}

#[cfg(windows)]
#[derive(Copy, Clone)]
enum EntryTarget {
    Takeover,
    Fallback,
    Shortcut,
}

/// Whether applying `new_enabled` to `target` would leave the panel with no
/// reachable entry. `takeover`/`fallback`/`shortcut` are the *current effective*
/// availability of each entry. Enabling is always allowed; disabling a target
/// is refused only when neither of the other two entries is actually available,
/// so a dead shortcut (registration error) or a tray that failed to build does
/// not count as a surviving entry.
#[cfg(windows)]
fn refuses_entry_change(
    takeover: bool,
    fallback: bool,
    shortcut: bool,
    target: EntryTarget,
    new_enabled: bool,
) -> bool {
    if new_enabled {
        return false;
    }
    let (t, f, s) = match target {
        EntryTarget::Takeover => (false, fallback, shortcut),
        EntryTarget::Fallback => (takeover, false, shortcut),
        EntryTarget::Shortcut => (takeover, fallback, false),
    };
    no_entry_available(t, f, s)
}

/// Snapshot of which Windows entries are *effectively* available right now:
/// takeover (by flag), fallback tray (built + visible), and the global
/// shortcut (enabled + no registration error). Used by the entry guards and
/// the focus-loss handler so dismissal never strands a panel with no entry.
#[cfg(windows)]
fn effective_entries(app: &tauri::AppHandle, state: &AppState) -> (bool, bool, bool) {
    let (takeover_flag, fallback_flag, shortcut_flag) = read_entry_flags(state);
    // The tray icon's visibility is always toggled in lockstep with the
    // persisted flag (apply_windows_fallback_tray calls set_visible(enabled)),
    // so the tray counts as available when the flag is on and the icon was
    // actually built. Tauri's TrayIcon exposes no is_visible() accessor.
    let fallback = fallback_flag
        && app.tray_by_id("calendar-fallback-tray").is_some();
    let shortcut = shortcut_flag
        && state
            .global_shortcut_error
            .lock()
            .expect("global shortcut error mutex poisoned")
            .is_none();
    (takeover_flag, fallback, shortcut)
}

#[cfg(windows)]
fn read_entry_flags(state: &AppState) -> (bool, bool, bool) {
    let data = state.store.data.lock().expect("store mutex poisoned");
    (
        data.taskbar_clock_takeover_enabled,
        data.fallback_tray_enabled,
        data.global_shortcut_enabled,
    )
}

#[cfg(windows)]
#[tauri::command]
fn fallback_tray_get(state: tauri::State<'_, AppState>) -> bool {
    state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .fallback_tray_enabled
}

#[cfg(windows)]
#[tauri::command]
fn fallback_tray_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    // Refuse to hide the last actually-available entry. The takeover flag and
    // the live shortcut error are checked here so a dead shortcut or a tray
    // that failed to build is not counted as a usable fallback.
    let (takeover, fallback, shortcut) = effective_entries(&app, &state);
    if refuses_entry_change(takeover, fallback, shortcut, EntryTarget::Fallback, enabled) {
        return Err("至少保留一个入口：任务栏时钟接管、托盘或全局快捷键".into());
    }
    let previous = state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .fallback_tray_enabled;
    // Persist via a transaction so a write failure (UnsafeToWrite / disk error)
    // is reported instead of silently leaving the flag set in memory only.
    state
        .store
        .transaction(|data| {
            data.fallback_tray_enabled = enabled;
            Ok(())
        })
        .map_err(|error| format!("无法保存设置：{error}"))?;
    if let Err(error) = apply_windows_fallback_tray(&app, &state) {
        // The tray did not actually appear; roll the persisted flag back so it
        // does not advertise an entry that does not exist.
        let _ = state.store.transaction(|data| {
            data.fallback_tray_enabled = previous;
            Ok(())
        });
        return Err(format!("托盘创建失败：{error}"));
    }
    Ok(enabled)
}

#[cfg(windows)]
#[tauri::command]
fn taskbar_clock_takeover_get(state: tauri::State<'_, AppState>) -> bool {
    state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .taskbar_clock_takeover_enabled
}

#[cfg(windows)]
#[tauri::command]
fn taskbar_clock_takeover_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    let (takeover, fallback, shortcut) = effective_entries(&app, &state);
    if refuses_entry_change(takeover, fallback, shortcut, EntryTarget::Takeover, enabled) {
        return Err("至少保留一个入口：任务栏时钟接管、托盘或全局快捷键".into());
    }
    match state.store.transaction(|data| {
        data.taskbar_clock_takeover_enabled = enabled;
        Ok(())
    }) {
        Ok(()) => {
            // The hook reads this static on every click; tracking and the hover
            // overlay consult it on their next poll, so the effect applies
            // without a restart. Only update it after the persist succeeded.
            TAKEOVER_ENABLED.store(enabled, Ordering::Relaxed);
            Ok(enabled)
        }
        Err(error) => Err(format!("无法保存设置：{error}")),
    }
}

/// Registers or unregisters the global wake shortcut. Returns the captured
/// error (if any) so the caller can surface it without failing app startup or
/// the IPC call. The Rust side owns registration; the JS API only toggles.
fn set_global_shortcut(app: &tauri::AppHandle, enabled: bool) -> Option<String> {
    GLOBAL_SHORTCUT_HELD.store(false, Ordering::Relaxed);
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcut = app.global_shortcut();
    // Always clear first so toggling enabled->enabled reclaims the hotkey and
    // disabled clears any lingering registration.
    if let Err(error) = shortcut.unregister_all() {
        return Some(error.to_string());
    }
    if enabled {
        match shortcut.register(GLOBAL_SHORTCUT) {
            Ok(()) => None,
            Err(error) => Some(error.to_string()),
        }
    } else {
        None
    }
}

/// Apply the persisted global-shortcut preference at startup and store the
/// resulting registration error so the UI can report a conflict.
fn configure_global_shortcut(app: &tauri::AppHandle, state: &AppState) {
    let enabled = state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .global_shortcut_enabled;
    let error = set_global_shortcut(app, enabled);
    *state
        .global_shortcut_error
        .lock()
        .expect("global shortcut error mutex poisoned") = error;
}

#[tauri::command]
fn global_shortcut_get(state: tauri::State<'_, AppState>) -> GlobalShortcutConfig {
    let enabled = state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .global_shortcut_enabled;
    let error = state
        .global_shortcut_error
        .lock()
        .expect("global shortcut error mutex poisoned")
        .clone();
    GlobalShortcutConfig {
        enabled,
        shortcut: GLOBAL_SHORTCUT.to_string(),
        error,
    }
}

#[tauri::command]
fn global_shortcut_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<GlobalShortcutConfig, String> {
    // Pre-check: refuse to disable the last reachable Windows entry before
    // touching the OS registration or the persisted flag.
    #[cfg(windows)]
    let suppressed_by_guard = {
        let (takeover, fallback, shortcut) = effective_entries(&app, &state);
        refuses_entry_change(takeover, fallback, shortcut, EntryTarget::Shortcut, enabled)
    };
    #[cfg(not(windows))]
    let suppressed_by_guard = false;
    if suppressed_by_guard {
        return Err("至少保留一个入口：任务栏时钟接管、托盘或全局快捷键".into());
    }

    // Apply the OS registration first so a failed enable is never reported as
    // enabled. The store flag is only changed once the hardware state is known.
    let registration_error = set_global_shortcut(&app, enabled);

    // An enable that could not register leaves the shortcut unusable; keep the
    // previous persisted flag and surface the conflict instead of advertising a
    // dead shortcut as enabled.
    let persisted_enabled = if enabled && registration_error.is_some() {
        state
            .store
            .data
            .lock()
            .expect("store mutex poisoned")
            .global_shortcut_enabled
    } else {
        state
            .store
            .transaction(|data| {
                data.global_shortcut_enabled = enabled;
                Ok(())
            })
            .map_err(|error| format!("无法保存快捷键设置：{error}"))?;
        enabled
    };

    *state
        .global_shortcut_error
        .lock()
        .expect("global shortcut error mutex poisoned") = registration_error.clone();
    Ok(GlobalShortcutConfig {
        enabled: persisted_enabled,
        shortcut: GLOBAL_SHORTCUT.to_string(),
        error: registration_error,
    })
}

#[cfg(target_os = "macos")]
fn configure_macos_panel(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::NSProcessInfo;

    if macos_glass_available() {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle};

        let ns_window = window.ns_window()? as *mut NSWindow;
        unsafe {
            let native = &*ns_window;
            if let Some(content) = native.contentView() {
                let glass = NSGlassEffectView::new(
                    MainThreadMarker::new().expect("panel requires main thread"),
                );
                glass.setFrame(content.frame());
                glass.setAutoresizingMask(
                    NSAutoresizingMaskOptions::ViewWidthSizable
                        | NSAutoresizingMaskOptions::ViewHeightSizable,
                );
                glass.setCornerRadius(16.0);
                glass.setStyle(NSGlassEffectViewStyle::Regular);
                glass.setContentView(Some(&content));
                native.setContentView(Some(&glass));
            }
        }
    } else {
        window.set_effects(
            EffectsBuilder::new()
                .effect(Effect::Menu)
                .radius(16.0)
                .build(),
        )?;
    }
    window.set_shadow(true)?;
    let ns_window = window.ns_window()? as *mut NSWindow;
    // The window is created by Tauri; AppKit settings make it behave as a transient menu panel.
    unsafe {
        // Full-screen apps cover floating windows; menu popups must sit above them.
        (*ns_window).setLevel(NSPopUpMenuWindowLevel);
        // Focus-loss handling below dismisses the panel without AppKit hiding it
        // during the activation change from the full-screen application.
        (*ns_window).setHidesOnDeactivate(false);
        // FullScreenAuxiliary only joins our own app's full-screen windows. On
        // macOS 13+, a floating overlay must explicitly join other apps' Spaces.
        let fullscreen_behavior = if NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 13
        {
            NSWindowCollectionBehavior::CanJoinAllApplications
        } else {
            NSWindowCollectionBehavior::FullScreenAuxiliary
        };
        (*ns_window).setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Transient
                | fullscreen_behavior,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_glass_available() -> bool {
    use objc2_foundation::NSProcessInfo;

    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        >= 26
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn macos_glass_enabled() -> bool {
    macos_glass_available()
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
        NSAttributedStringNSStringDrawing, NSBezierPath, NSBitmapImageRep, NSColor,
        NSDeviceRGBColorSpace, NSFont, NSFontAttributeName, NSForegroundColorAttributeName,
        NSGraphicsContext,
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
        let keys: [&NSAttributedStringKey; 2] =
            unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
        let values: [&AnyObject; 2] = [font.as_ref(), color.as_ref()];
        let attributes = NSDictionary::from_slices(&keys, &values);
        let string = NSString::from_str(text);
        let line = unsafe {
            NSAttributedString::initWithString_attributes(
                NSAttributedString::alloc(),
                &string,
                Some(&attributes),
            )
        };
        let size = line.size();
        line.drawAtPoint(objc2_foundation::NSPoint::new(
            (SIZE as f64 - size.width) / 2.0,
            bottom,
        ));
    };

    match style {
        MenuBarStyle::Date => draw_line(&today.day().to_string(), 32.0, 2.0),
        MenuBarStyle::WeekdayDate => {
            let weekday = ["日", "一", "二", "三", "四", "五", "六"]
                [today.weekday().num_days_from_sunday() as usize];
            draw_line(&format!("周{weekday}"), 18.0, 22.0);
            draw_line(&today.day().to_string(), 22.0, 0.0);
        }
        MenuBarStyle::Calendar => unreachable!(),
    }

    NSGraphicsContext::restoreGraphicsState_class();
    let mut pixels = vec![0; SIZE * SIZE * 4];
    let bitmap = rep.bitmapData();
    for row in 0..SIZE {
        let source =
            unsafe { std::slice::from_raw_parts(bitmap.add(row * bytes_per_row), SIZE * 4) };
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
        let Some(item) = inner.ns_status_item() else {
            return;
        };
        let Some(button) =
            item.button(MainThreadMarker::new().expect("menu bar requires main thread"))
        else {
            return;
        };
        if let Some(image) = button.image() {
            image.setSize(NSSize::new(22.0, 22.0));
        }
    })
}

#[cfg(target_os = "macos")]
fn update_menu_bar_icon(app: &tauri::AppHandle, style: MenuBarStyle) -> Result<(), String> {
    let tray = app
        .tray_by_id("calendar-menu-bar")
        .ok_or("菜单栏图标不可用")?;
    let icon = if style == MenuBarStyle::Calendar {
        menu_bar_icon()
    } else {
        menu_bar_date_icon(style)
    };
    tray.set_icon_with_as_template(Some(icon), style == MenuBarStyle::Calendar)
        .map_err(|error| error.to_string())?;
    enlarge_menu_bar_icon(&tray).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn menu_bar_style_get(state: tauri::State<'_, AppState>) -> MenuBarStyle {
    state
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .menu_bar_style
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn menu_bar_style_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    style: MenuBarStyle,
) -> Result<(), String> {
    update_menu_bar_icon(&app, style)?;
    state.store.with(|data| data.menu_bar_style = style);
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_calendar_below_tray(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        #[cfg(debug_assertions)]
        eprintln!("calendar tray: main window missing");
        return;
    };
    let Some(tray) = app.tray_by_id("calendar-menu-bar") else {
        return;
    };
    // Use the status item's own screen and AppKit coordinates on every display.
    let Ok(Some((tray_frame, visible_frame))) = tray.with_inner_tray_icon(|inner| {
        let item = inner.ns_status_item()?;
        let button = item.button(objc2::MainThreadMarker::new()?)?;
        let status_window = button.window()?;
        let screen = status_window.screen()?;
        let frame = status_window.frame();
        let visible = screen.visibleFrame();
        Some((
            (frame.origin.x, frame.origin.y, frame.size.width),
            (
                visible.origin.x,
                visible.origin.y,
                visible.size.width,
                visible.size.height,
            ),
        ))
    }) else {
        #[cfg(debug_assertions)]
        eprintln!("calendar tray: failed to read status item screen");
        return;
    };
    MAIN_PANEL_FOCUSED.store(false, Ordering::Relaxed);
    // A key window in an inactive app still requires a click before its webview
    // receives input. Activate the accessory app when opening the calendar.
    match window.ns_window() {
        Ok(ns_window) => unsafe {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;
            use objc2_foundation::NSPoint;

            let panel = &*(ns_window as *mut objc2_app_kit::NSWindow);
            let size = panel.frame().size;
            const SAFE_MARGIN: f64 = 12.0;
            let left = visible_frame.0 + SAFE_MARGIN;
            let bottom = visible_frame.1 + size.height + SAFE_MARGIN;
            let x = (tray_frame.0 + (tray_frame.2 - size.width) / 2.0).clamp(
                left,
                (visible_frame.0 + visible_frame.2 - size.width - SAFE_MARGIN).max(left),
            );
            let y = (tray_frame.1 - 6.0).clamp(
                bottom,
                (visible_frame.1 + visible_frame.3 - SAFE_MARGIN).max(bottom),
            );
            panel.setFrameTopLeftPoint(NSPoint::new(x, y));
            panel.orderFrontRegardless();
            #[allow(deprecated)]
            NSApplication::sharedApplication(
                MainThreadMarker::new().expect("menu bar requires main thread"),
            )
            .activateIgnoringOtherApps(true);
            panel.makeKeyAndOrderFront(None);
            #[cfg(debug_assertions)]
            eprintln!("calendar tray: show at AppKit ({x}, {y}), screen={visible_frame:?}");
        },
        Err(error) => eprintln!("calendar tray: failed to get native panel: {error}"),
    }
}

#[cfg(target_os = "macos")]
fn toggle_calendar_below_tray(app: &tauri::AppHandle) {
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
            show_calendar_below_tray(app);
        }
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_menu_bar(app: &mut tauri::App) -> tauri::Result<()> {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    if let Some(window) = app.get_webview_window("main") {
        configure_macos_panel(&window)?;
    }

    let style = app
        .state::<AppState>()
        .store
        .data
        .lock()
        .expect("store mutex poisoned")
        .menu_bar_style;
    let icon = if style == MenuBarStyle::Calendar {
        menu_bar_icon()
    } else {
        menu_bar_date_icon(style)
    };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open-calendar", "打开日历", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?,
            &MenuItem::with_id(app, "menubar-settings", "标题栏设置", true, None::<&str>)?,
            &MenuItem::with_id(app, "online-update", "在线更新", true, None::<&str>)?,
            &MenuItem::with_id(app, "about", "关于", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;
    let tray = TrayIconBuilder::with_id("calendar-menu-bar")
        .icon(icon)
        .icon_as_template(style == MenuBarStyle::Calendar)
        .tooltip("日历")
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
                return;
            }
            let ui_event = match event.id().as_ref() {
                "open-calendar" => None,
                "settings" => Some("open-settings"),
                "menubar-settings" => Some("open-menubar-settings"),
                "online-update" => Some("open-update"),
                "about" => Some("open-about"),
                _ => return,
            };
            show_calendar_below_tray(app);
            if let Some(ui_event) = ui_event {
                let _ = app.emit(ui_event, ());
            }
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
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
                            toggle_calendar_below_tray(app);
                            let _ = app.emit("taskbar-calendar-click", ());
                        }
                        MouseButton::Right => {
                            // A permanently attached NSMenu intercepts left clicks on the status item.
                            // Attach it only while displaying the native right-click menu.
                            if let Err(error) = tray.set_menu(Some(menu.clone())) {
                                eprintln!("calendar tray: failed to attach menu: {error}");
                                return;
                            }
                            if let Err(error) = tray.with_inner_tray_icon(|inner| inner.show_menu())
                            {
                                eprintln!("calendar tray: failed to show menu: {error}");
                            }
                            if let Err(error) = tray.set_menu(None::<Menu<tauri::Wry>>) {
                                eprintln!("calendar tray: failed to detach menu: {error}");
                            }
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
                    let style = app
                        .state::<AppState>()
                        .store
                        .data
                        .lock()
                        .expect("store mutex poisoned")
                        .menu_bar_style;
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

/// Hide the calendar and all auxiliary panels. Used by the Escape key so the
/// gesture collapses every window at once instead of only the focused one.
#[tauri::command]
fn hide_calendar(app: tauri::AppHandle) {
    hide_main_panel(&app);
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
async fn open_aux_panel(
    app: tauri::AppHandle,
    panel: String,
    date: Option<String>,
) -> Result<(), String> {
    let (label, title, width) = match panel.as_str() {
        "detail" => ("detail", "日期详情", 350.0),
        "clock" => ("clock", "世界时间", 520.0),
        _ => return Err("未知面板".into()),
    };
    let main = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let main_pos = main
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let main_size = main
        .outer_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let height = if label == "detail" {
        main.inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale)
            .height
    } else {
        300.0
    };
    let (left, top, right, bottom) =
        if let Some(monitor) = main.current_monitor().map_err(|error| error.to_string())? {
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
            (
                main_pos.x,
                main_pos.y,
                main_pos.x + main_size.width,
                main_pos.y + main_size.height,
            )
        };
    let x = if main_pos.x - width - 12.0 >= left {
        main_pos.x - width - 12.0
    } else {
        main_pos.x + main_size.width + 12.0
    }
    .clamp(left, (right - width).max(left));
    let y = main_pos.y.clamp(top, (bottom - height).max(top));
    if let Some(window) = app.get_webview_window(label) {
        if label == "detail" {
            window
                .set_position(tauri::LogicalPosition::new(x, y))
                .map_err(|error| error.to_string())?;
            if let Some(date) = date {
                app.emit_to(label, "detail-date-changed", date)
                    .map_err(|error| error.to_string())?;
            }
        }
        if !window.is_visible().map_err(|error| error.to_string())? {
            #[cfg(target_os = "macos")]
            show_macos_aux_panel(window, false).await?;
            #[cfg(not(target_os = "macos"))]
            {
                window.show().map_err(|error| error.to_string())?;
                window.set_focus().map_err(|error| error.to_string())?;
            }
        }
        return Ok(());
    }
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
        .accept_first_mouse(true)
        .visible(!cfg!(target_os = "macos"))
        .focused(!cfg!(target_os = "macos") || label != "detail")
        .build()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        show_macos_aux_panel(window, true).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_focus().map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn show_macos_aux_panel(
    window: tauri::WebviewWindow,
    newly_created: bool,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    let main = app.get_webview_window("main").ok_or("日历窗口不可用")?;
    app.run_on_main_thread(move || {
        let result = (|| -> tauri::Result<()> {
            if newly_created {
                configure_macos_panel(&window)?;
            }
            if window.label() == "detail" {
                let native = window.ns_window()? as *mut objc2_app_kit::NSWindow;
                let parent = main.ns_window()? as *mut objc2_app_kit::NSWindow;
                unsafe {
                    if newly_created {
                        // Follow the main panel into the full-screen Space it joined.
                        (*parent).addChildWindow_ordered(
                            &*native,
                            objc2_app_kit::NSWindowOrderingMode::Above,
                        );
                    }
                    // show() makes the window key; keep the calendar interactive.
                    (*native).orderFrontRegardless();
                }
            } else {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })()
        .map_err(|error| error.to_string());
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    // Only act on the press edge; ignore release and OS key-repeat.
                    if event.state != ShortcutState::Pressed {
                        GLOBAL_SHORTCUT_HELD.store(false, Ordering::Relaxed);
                        return;
                    }
                    if GLOBAL_SHORTCUT_HELD.swap(true, Ordering::Relaxed) {
                        return;
                    }
                    let runner = app.clone();
                    let panel = app.clone();
                    // Toggle on the main thread: macOS reuses the menu-bar anchor
                    // / Space semantics; Windows anchors at the cursor work area.
                    let _ = runner.run_on_main_thread(move || {
                        #[cfg(target_os = "macos")]
                        toggle_calendar_below_tray(&panel);
                        #[cfg(windows)]
                        {
                            let mut cursor = POINT::default();
                            let (x, y) = if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
                                (cursor.x, cursor.y)
                            } else {
                                (0, 0)
                            };
                            toggle_calendar_at(&panel, x, y);
                        }
                        #[cfg(not(any(target_os = "macos", windows)))]
                        {
                            let _ = &panel;
                        }
                    });
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            #[cfg(windows)]
            date_format::taskbar_date_format_get,
            #[cfg(windows)]
            date_format::taskbar_date_format_preview,
            #[cfg(windows)]
            date_format::taskbar_date_format_set,
            #[cfg(windows)]
            date_format::taskbar_time_format_get,
            #[cfg(windows)]
            date_format::taskbar_time_format_preview,
            #[cfg(windows)]
            date_format::taskbar_time_format_set,
            #[cfg(target_os = "macos")]
            menu_bar_style_get,
            #[cfg(target_os = "macos")]
            menu_bar_style_set,
            #[cfg(target_os = "macos")]
            macos_glass_enabled,
            quit_app,
            show_update_panel,
            commands::update::check_for_updates,
            commands::update::install_update,
            commands::autostart::autostart_get,
            commands::autostart::autostart_set,
            commands::runtime::runtime_preferences_get,
            commands::runtime::runtime_preferences_set,
            commands::runtime::storage_health_get,
            global_shortcut_get,
            global_shortcut_set,
            #[cfg(windows)]
            fallback_tray_get,
            #[cfg(windows)]
            fallback_tray_set,
            #[cfg(windows)]
            taskbar_clock_takeover_get,
            #[cfg(windows)]
            taskbar_clock_takeover_set,
            open_aux_panel,
            close_aux_panel,
            hide_calendar,
            commands::world_time::world_time_list_cities,
            commands::world_time::world_time_search,
            commands::world_time::world_time_clocks,
            commands::world_time::world_time_use_24_hour,
            commands::world_time::world_time_set_use_24_hour,
            commands::world_time::world_time_add,
            commands::world_time::world_time_remove,
            commands::world_time::world_time_reorder,
            commands::location::location_get,
            commands::location::location_search,
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

            // Register the persisted global wake shortcut (default on). A
            // registration conflict is captured into state rather than failing
            // startup; the UI reports it via global_shortcut_get.
            configure_global_shortcut(app.handle(), app.state::<AppState>().inner());

            #[cfg(target_os = "macos")]
            setup_macos_menu_bar(app)?;

            #[cfg(windows)]
            {
                app.on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "system-clock" => {
                            let point = *SYSTEM_CLOCK_POINT
                                .lock()
                                .expect("clock point mutex poisoned");
                            let opened = std::thread::spawn(move || {
                                if let Err(error) = taskbar_clock::open_system_clock(point) {
                                    eprintln!("calendar: failed to open system clock: {error}");
                                    false
                                } else {
                                    true
                                }
                            });
                            *SYSTEM_CLOCK_ACTIVE
                                .lock()
                                .expect("system clock mutex poisoned") = Some((point, opened));
                            return;
                        }
                        "system-date-time" | "system-notifications" => {
                            let url = if event.id().as_ref() == "system-date-time" {
                                "ms-settings:dateandtime"
                            } else {
                                "ms-settings:notifications"
                            };
                            if let Err(error) = app.opener().open_url(url, None::<&str>) {
                                eprintln!("calendar: failed to open {url}: {error}");
                            }
                            return;
                        }
                        _ => {}
                    }
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                        return;
                    }
                    let ui_event = match event.id().as_ref() {
                        "open-calendar" => None,
                        "settings" => Some("open-settings"),
                        "online-update" => Some("open-update"),
                        "about" => Some("open-about"),
                        _ => return,
                    };
                    // Anchor the panel to the monitor the cursor is on instead of
                    // reusing its last position, so opening from the taskbar or the
                    // fallback-tray menu lands on the active display's work area.
                    let mut cursor = POINT::default();
                    let (x, y) = if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
                        (cursor.x, cursor.y)
                    } else {
                        (0, 0)
                    };
                    show_calendar_at(app, x, y);
                    if let Some(ui_event) = ui_event {
                        let _ = app.emit(ui_event, ());
                    } else {
                        let _ = app.emit("taskbar-calendar-click", ());
                    }
                });
                // Initialize the takeover flag before starting the hook thread:
                // the mouse hook reads TAKEOVER_ENABLED on its first click, and a
                // late store could otherwise let a disabled-takeover run briefly
                // intercept the clock. Bind the State guard before reading it so
                // the borrow is not tied to a dropped temporary (E0716).
                {
                    let state = app.state::<AppState>();
                    let takeover = state
                        .store
                        .data
                        .lock()
                        .expect("store mutex poisoned")
                        .taskbar_clock_takeover_enabled;
                    TAKEOVER_ENABLED.store(takeover, Ordering::Relaxed);
                }
                start_mouse_hook(app.handle().clone());
                let state = app.state::<AppState>();
                if let Err(error) = apply_windows_fallback_tray(app.handle(), &state) {
                    eprintln!("calendar: fallback tray unavailable: {error}");
                }
                // The autostart plugin relaunches with `--autostart`; in that
                // case keep the panel hidden so a login launch does not pop a
                // window over the user's session. The fallback tray and the
                // global shortcut still provide reliable entry. The only
                // exception is when no entry is actually available at all: then
                // the panel must stay visible or the app becomes unreachable.
                let launched_at_login = std::env::args().any(|arg| arg == "--autostart");
                let (takeover, fallback, shortcut) = effective_entries(app.handle(), &state);
                let no_entry = no_entry_available(takeover, fallback, shortcut);
                if !launched_at_login || no_entry {
                    let mut cursor = POINT::default();
                    if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
                        show_calendar_at(app.handle(), cursor.x, cursor.y);
                    } else {
                        show_calendar_at(app.handle(), 0, 0);
                    }
                }
            }

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
                #[cfg(windows)]
                if let Some((clock_point, opened)) = SYSTEM_CLOCK_ACTIVE
                    .lock()
                    .expect("system clock mutex poisoned")
                    .take()
                {
                    let app = handle.clone();
                    std::thread::spawn(move || {
                        close_system_clock(clock_point, opened);
                        let panel = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            toggle_calendar_at(&panel, x as i32, y as i32)
                        });
                    });
                    return;
                }
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
                #[cfg(windows)]
                {
                    let system_clock = SYSTEM_CLOCK_ACTIVE
                        .lock()
                        .expect("system clock mutex poisoned")
                        .take();
                    let app = handle.clone();
                    std::thread::spawn(move || {
                        if let Some((clock_point, opened)) = system_clock {
                            close_system_clock(clock_point, opened);
                        }
                        if let Err(error) = show_windows_context_menu(&app, x as i32, y as i32) {
                            eprintln!("calendar: failed to show native context menu: {error}");
                        }
                    });
                }
                #[cfg(not(windows))]
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
                tauri::WindowEvent::Focused(true) => {
                    PANEL_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed);
                    if window.label() == "main" {
                        MAIN_PANEL_FOCUSED.store(true, Ordering::Relaxed);
                    }
                }
                #[cfg(windows)]
                tauri::WindowEvent::Focused(true) => {
                    WINDOWS_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed);
                }
                tauri::WindowEvent::Focused(false) => {
                    #[cfg(target_os = "macos")]
                    {
                        #[cfg(debug_assertions)]
                        eprintln!("calendar tray: {} lost focus", window.label());
                        let generation = PANEL_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
                        let window = window.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                            let app = window.app_handle().clone();
                            let _ = app.run_on_main_thread(move || {
                                if PANEL_FOCUS_GENERATION.load(Ordering::Relaxed) != generation {
                                    return;
                                }
                                let panel_focused =
                                    ["main", "detail", "clock"].iter().any(|label| {
                                        window
                                            .app_handle()
                                            .get_webview_window(label)
                                            .is_some_and(|aux| aux.is_focused().unwrap_or(false))
                                    });
                                // Moving between our panels is not dismissal.
                                if !panel_focused && MAIN_PANEL_FOCUSED.load(Ordering::Relaxed) {
                                    hide_main_panel(window.app_handle());
                                }
                            });
                        });
                    }
                    #[cfg(windows)]
                    {
                        let generation =
                            WINDOWS_FOCUS_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                            let panel_app = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                if WINDOWS_FOCUS_GENERATION.load(Ordering::Relaxed) != generation {
                                    return;
                                }
                                let panel_focused =
                                    ["main", "detail", "clock"].iter().any(|label| {
                                        panel_app.get_webview_window(label).is_some_and(|panel| {
                                            panel.is_focused().unwrap_or(false)
                                        })
                                    });
                                if !panel_focused {
                                    // Do not strand the panel: if no entry is
                                    // actually available (takeover off, tray
                                    // missing/hidden, shortcut in error), keep
                                    // the window visible so it stays reachable.
                                    let state = panel_app.state::<AppState>();
                                    let (takeover, fallback, shortcut) =
                                        effective_entries(&panel_app, &state);
                                    if !no_entry_available(takeover, fallback, shortcut) {
                                        hide_main_panel(&panel_app);
                                    }
                                }
                            });
                        });
                    }
                    #[cfg(all(not(target_os = "macos"), not(windows)))]
                    {
                        let aux_visible = ["detail", "clock"].iter().any(|label| {
                            window
                                .app_handle()
                                .get_webview_window(label)
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

#[cfg(all(windows, test))]
mod tests {
    use super::{no_entry_available, refuses_entry_change, EntryTarget};

    #[test]
    fn no_entry_available_only_when_all_three_off() {
        // Any single live entry keeps the panel reachable.
        assert!(no_entry_available(false, false, false));
        assert!(!no_entry_available(true, false, false));
        assert!(!no_entry_available(false, true, false));
        assert!(!no_entry_available(false, false, true));
        assert!(!no_entry_available(true, true, true));
        // Two-off combinations: as long as one remains, the panel is reachable.
        assert!(!no_entry_available(false, true, true));
        assert!(!no_entry_available(true, false, true));
        assert!(!no_entry_available(true, true, false));
    }

    #[test]
    fn disabling_takeover_rejected_only_when_others_unavailable() {
        // The takeover flag (unverifiable hook) is not a surviving entry once it
        // is being turned off; only a real tray or shortcut keeps the panel open.
        assert!(refuses_entry_change(false, false, false, EntryTarget::Takeover, false));
        assert!(!refuses_entry_change(false, true, false, EntryTarget::Takeover, false));
        assert!(!refuses_entry_change(false, false, true, EntryTarget::Takeover, false));
        assert!(!refuses_entry_change(false, true, true, EntryTarget::Takeover, false));
    }

    #[test]
    fn disabling_fallback_rejected_when_others_dead() {
        // Takeover off + shortcut in error (shortcut=false): refusing to hide
        // the last actually-working tray even though it is the target.
        assert!(refuses_entry_change(false, true, false, EntryTarget::Fallback, false));
        assert!(refuses_entry_change(false, false, false, EntryTarget::Fallback, false));
        // A surviving takeover or shortcut allows hiding the tray.
        assert!(!refuses_entry_change(true, true, false, EntryTarget::Fallback, false));
        assert!(!refuses_entry_change(false, true, true, EntryTarget::Fallback, false));
    }

    #[test]
    fn disabling_shortcut_rejected_when_others_dead() {
        // Takeover off + tray failed to build (fallback=false): the shortcut is
        // the only live entry, so disabling it must be refused.
        assert!(refuses_entry_change(false, false, true, EntryTarget::Shortcut, false));
        assert!(refuses_entry_change(false, false, false, EntryTarget::Shortcut, false));
        assert!(!refuses_entry_change(true, false, true, EntryTarget::Shortcut, false));
        assert!(!refuses_entry_change(false, true, true, EntryTarget::Shortcut, false));
    }

    #[test]
    fn enabling_a_target_is_never_refused() {
        assert!(!refuses_entry_change(false, false, false, EntryTarget::Takeover, true));
        assert!(!refuses_entry_change(false, false, false, EntryTarget::Fallback, true));
        assert!(!refuses_entry_change(false, false, false, EntryTarget::Shortcut, true));
    }
}
