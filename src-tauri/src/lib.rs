use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(windows)]
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, POINT, WPARAM},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetAncestor, GetClassNameW, GetMessageW, GetParent,
        GetWindowRect, HHOOK, HWND, MSG, MSLLHOOKSTRUCT, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, WindowFromPoint, GA_ROOT, HC_ACTION, WH_MOUSE_LL, WM_LBUTTONUP,
        WM_RBUTTONUP,
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
    if hwnd.0 == 0 {
        return false;
    }

    let mut current = hwnd;
    for _ in 0..8 {
        let name = class_name(current);
        if name.contains("Clock") || name.contains("DateTime") || name == "TrayClockWClass" {
            return true;
        }
        current = unsafe { GetParent(current) };
        if current.0 == 0 {
            break;
        }
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.0 == 0 || class_name(root) != "Shell_TrayWnd" {
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
    if code == HC_ACTION as i32 && (message.0 == WM_LBUTTONUP as usize || message.0 == WM_RBUTTONUP as usize) {
        let mouse = *(data.0 as *const MSLLHOOKSTRUCT);
        if is_taskbar_clock(mouse.pt) {
            if let Some(app) = APP_HANDLE.get() {
                let event = if message.0 == WM_LBUTTONUP as usize {
                    "taskbar-calendar-click"
                } else {
                    "taskbar-calendar-context"
                };
                let _ = app.emit(event, serde_json::json!({ "x": mouse.pt.x, "y": mouse.pt.y }));
            }
            return LRESULT(1);
        }
    }
    CallNextHookEx(HHOOK::default(), code, message, data)
}

#[cfg(windows)]
fn start_mouse_hook(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
    std::thread::spawn(|| {
        let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) };
        let Ok(hook) = hook else { return };
        let mut message = MSG::default();
        while unsafe { GetMessageW(&mut message, HWND::default(), 0, 0) }.0 > 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    });
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![quit_app])
        .setup(|app| {
            #[cfg(windows)]
            start_mouse_hook(app.handle().clone());

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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
