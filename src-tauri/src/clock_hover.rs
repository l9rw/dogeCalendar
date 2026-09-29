use std::sync::OnceLock;
use tauri::Emitter;
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{GetStockObject, BLACK_BRUSH, HBRUSH},
        UI::{
            Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT},
            WindowsAndMessaging::*,
        },
    },
};

const TIMER: usize = 1;
const REFRESH_INTERVAL_MS: u32 = 200;
const WM_MOUSELEAVE: u32 = 0x02a3;

#[derive(Default)]
struct Pressed {
    left: bool,
    right: bool,
}

impl Pressed {
    fn update(&mut self, message: u32) -> Option<&'static str> {
        match message {
            WM_LBUTTONDOWN => self.left = true,
            WM_RBUTTONDOWN => self.right = true,
            WM_LBUTTONUP if std::mem::take(&mut self.left) => {
                return Some("taskbar-calendar-click");
            }
            WM_RBUTTONUP if std::mem::take(&mut self.right) => {
                return Some("taskbar-calendar-context");
            }
            _ => {}
        }
        None
    }
}

struct Overlay {
    rect: RECT,
    pressed: Pressed,
}

struct Controller {
    main: HWND,
    overlays: Vec<(HWND, RECT)>,
}

impl Controller {
    unsafe fn clear(&mut self) {
        for (hwnd, _) in self.overlays.drain(..) {
            let _ = ShowWindow(hwnd, SW_HIDE);
            let _ = DestroyWindow(hwnd);
        }
    }

    unsafe fn refresh(&mut self) {
        let mut rects = crate::taskbar_clock::hover_rects();
        rects.retain(|rect| dimensions(*rect).is_some());
        rects.sort_unstable_by_key(|rect| (rect.left, rect.top, rect.right, rect.bottom));
        rects.dedup();
        if !self.overlays.iter().map(|(_, rect)| rect).eq(rects.iter()) {
            // Remove old hit targets before exposing any replacement layout.
            self.clear();
            for rect in rects {
                let Some((width, height)) = dimensions(rect) else {
                    continue;
                };
                let Ok(hwnd) = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    w!("CalendarClockHoverOverlay"),
                    w!(""),
                    WS_POPUP,
                    rect.left,
                    rect.top,
                    width,
                    height,
                    None,
                    None,
                    None,
                    None,
                ) else {
                    self.clear();
                    return;
                };
                let state = Box::into_raw(Box::new(Overlay {
                    rect,
                    pressed: Pressed::default(),
                }));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
                if GetWindowLongPtrW(hwnd, GWLP_USERDATA) != state as isize {
                    drop(Box::from_raw(state));
                    let _ = DestroyWindow(hwnd);
                    self.clear();
                    return;
                }
                self.overlays.push((hwnd, rect));
                // Alpha zero would make the layered window input-transparent.
                if SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA).is_err() {
                    self.clear();
                    return;
                }
            }
        }
        for &(hwnd, _) in &self.overlays {
            if SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .is_err()
            {
                self.clear();
                return;
            }
        }
    }
}

fn dimensions(rect: RECT) -> Option<(i32, i32)> {
    let width = rect.right.checked_sub(rect.left)?;
    let height = rect.bottom.checked_sub(rect.top)?;
    (width > 0 && height > 0).then_some((width, height))
}

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => return LRESULT(HTCLIENT as isize),
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        _ => {}
    }
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Overlay;
    if !state.is_null() {
        match message {
            WM_NCDESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(state));
            }
            WM_CANCELMODE | WM_CAPTURECHANGED | WM_MOUSELEAVE | WM_DESTROY => {
                (*state).pressed = Pressed::default();
            }
            WM_SHOWWINDOW if wparam.0 == 0 => (*state).pressed = Pressed::default(),
            WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
                // No capture: leaving the overlay cancels this click entirely.
                let mut tracking = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                if TrackMouseEvent(&mut tracking).is_ok() {
                    (*state).pressed.update(message);
                } else {
                    (*state).pressed = Pressed::default();
                }
                return LRESULT(0);
            }
            WM_LBUTTONUP | WM_RBUTTONUP => {
                let event = (*state).pressed.update(message);
                let rect = (*state).rect;
                let mut point = POINT::default();
                if let Some(event) = event {
                    if crate::taskbar_clock::hover_rects().contains(&rect)
                        && GetCursorPos(&mut point).is_ok()
                        && point.x >= rect.left
                        && point.x < rect.right
                        && point.y >= rect.top
                        && point.y < rect.bottom
                    {
                        if let Some(app) = crate::APP_HANDLE.get() {
                            let _ =
                                app.emit(event, serde_json::json!({ "x": point.x, "y": point.y }));
                        }
                    }
                }
                return LRESULT(0);
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

unsafe extern "system" fn controller_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Controller;
    if !state.is_null() {
        match message {
            WM_TIMER if wparam.0 == TIMER => {
                if IsWindow(Some((*state).main)).as_bool() {
                    (*state).refresh();
                } else {
                    let _ = DestroyWindow(hwnd);
                }
                return LRESULT(0);
            }
            WM_DESTROY => {
                let _ = KillTimer(Some(hwnd), TIMER);
                (*state).clear();
            }
            WM_NCDESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                drop(Box::from_raw(state));
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

/// Must run on the hook thread, which owns the native message loop.
pub(super) fn start(main: HWND) {
    static REGISTERED: OnceLock<bool> = OnceLock::new();
    unsafe {
        if !*REGISTERED.get_or_init(|| {
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(controller_proc),
                lpszClassName: w!("CalendarClockHoverController"),
                ..Default::default()
            }) != 0
                && RegisterClassW(&WNDCLASSW {
                    lpfnWndProc: Some(overlay_proc),
                    lpszClassName: w!("CalendarClockHoverOverlay"),
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                    ..Default::default()
                }) != 0
        }) {
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("CalendarClockHoverController"),
            w!(""),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        ) else {
            return;
        };
        let state = Box::into_raw(Box::new(Controller {
            main,
            overlays: Vec::new(),
        }));
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
        if GetWindowLongPtrW(hwnd, GWLP_USERDATA) != state as isize {
            drop(Box::from_raw(state));
            let _ = DestroyWindow(hwnd);
            return;
        }
        if SetTimer(Some(hwnd), TIMER, REFRESH_INTERVAL_MS, None) == 0 {
            let _ = DestroyWindow(hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_require_matching_down_on_the_same_overlay() {
        let mut first = Pressed::default();
        let mut second = Pressed::default();
        assert_eq!(first.update(WM_LBUTTONUP), None);
        assert_eq!(first.update(WM_LBUTTONDOWN), None);
        assert_eq!(first.update(WM_RBUTTONUP), None);
        assert_eq!(second.update(WM_LBUTTONUP), None);
        assert_eq!(first.update(WM_LBUTTONUP), Some("taskbar-calendar-click"));
        assert_eq!(first.update(WM_LBUTTONUP), None);
        first.update(WM_RBUTTONDOWN);
        assert_eq!(first.update(WM_RBUTTONUP), Some("taskbar-calendar-context"));
        first.update(WM_LBUTTONDOWN);
        first = Pressed::default();
        assert_eq!(first.update(WM_LBUTTONUP), None);
    }

    #[test]
    fn dimensions_reject_empty_inverted_and_overflowing_bounds() {
        let mut rect = RECT {
            left: -100,
            top: -40,
            right: -20,
            bottom: 0,
        };
        assert_eq!(dimensions(rect), Some((80, 40)));
        rect.right = rect.left;
        assert_eq!(dimensions(rect), None);
        rect.right -= 1;
        assert_eq!(dimensions(rect), None);
        rect.left = i32::MIN;
        rect.right = i32::MAX;
        assert_eq!(dimensions(rect), None);
        assert_eq!(dimensions(RECT::default()), None);
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn native_overlay_is_input_opaque_nonactivating_when_panel_hidden() {
        struct Windows(Vec<HWND>);
        impl Drop for Windows {
            fn drop(&mut self) {
                for hwnd in self.0.drain(..).rev() {
                    unsafe {
                        let _ = DestroyWindow(hwnd);
                    }
                }
            }
        }
        unsafe {
            let foreground = GetForegroundWindow();
            let mut windows = Windows(Vec::new());
            let main = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!(""),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            windows.0.push(main);
            let _ = ShowWindow(main, SW_SHOWNOACTIVATE);
            assert!(IsWindowVisible(main).as_bool());
            assert_ne!(
                RegisterClassW(&WNDCLASSW {
                    lpfnWndProc: Some(overlay_proc),
                    lpszClassName: w!("CalendarClockHoverTest"),
                    hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                    ..Default::default()
                }),
                0
            );
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("CalendarClockHoverTest"),
                w!(""),
                WS_POPUP,
                40,
                40,
                40,
                40,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            windows.0.push(hwnd);
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA).unwrap();
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .unwrap();
            let _ = windows::Win32::Graphics::Gdi::UpdateWindow(hwnd);
            assert_eq!(WindowFromPoint(POINT { x: 60, y: 60 }), hwnd);
            assert_eq!(GetForegroundWindow(), foreground);
            assert_eq!(
                SendMessageW(hwnd, WM_MOUSEACTIVATE, None, None),
                LRESULT(MA_NOACTIVATE as isize)
            );
            let state = Box::into_raw(Box::new(Overlay {
                rect: RECT {
                    left: 40,
                    top: 40,
                    right: 80,
                    bottom: 80,
                },
                pressed: Pressed::default(),
            }));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
            let mut controller = Controller {
                main,
                overlays: vec![(
                    hwnd,
                    RECT {
                        left: 40,
                        top: 40,
                        right: 80,
                        bottom: 80,
                    },
                )],
            };
            let _ = ShowWindow(main, SW_HIDE);
            let _ = SendMessageW(hwnd, WM_LBUTTONDOWN, None, None);
            assert!(IsWindowVisible(hwnd).as_bool());
            assert!(!IsWindowVisible(main).as_bool());
            assert!((*state).pressed.left);
            controller.clear();
            assert!(controller.overlays.is_empty());
            assert!(!IsWindow(Some(hwnd)).as_bool());
            windows.0.pop();
        }
    }
}
