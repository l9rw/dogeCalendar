use std::{
    sync::RwLock,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    },
    UI::{
        Accessibility::{CUIAutomation, IUIAutomation, TreeScope_Children, TreeScope_Descendants},
        WindowsAndMessaging::{GetWindowRect, IsWindowVisible},
    },
};

struct ClockBounds {
    taskbar: usize,
    taskbar_rect: RECT,
    clock_rect: RECT,
}

static CLOCKS: RwLock<Option<(Instant, Vec<ClockBounds>)>> = RwLock::new(None);
const TRACKING_INTERVAL: Duration = Duration::from_millis(500);

pub(super) fn is_taskbar_class(name: &str) -> bool {
    matches!(name, "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

fn point_in_rect(point: POINT, rect: RECT) -> bool {
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

pub(super) fn contains(taskbar: HWND, point: POINT) -> bool {
    // Never block the low-level mouse hook on UI Automation or its worker.
    let Ok(clocks) = CLOCKS.try_read() else {
        return false;
    };
    let Some((updated, clocks)) = clocks.as_ref() else {
        return false;
    };
    if updated.elapsed() > Duration::from_secs(1) {
        return false;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(taskbar, &mut rect) }.is_err() {
        return false;
    }
    clocks.iter().any(|clock| {
        clock.taskbar == taskbar.0 as usize
            && clock.taskbar_rect == rect
            && point_in_rect(point, rect)
            && point_in_rect(point, clock.clock_rect)
    })
}

pub(super) fn hover_rects() -> Vec<RECT> {
    let Ok(cached) = CLOCKS.try_read() else {
        return Vec::new();
    };
    let Some((updated, clocks)) = cached.as_ref() else {
        return Vec::new();
    };
    if updated.elapsed() > Duration::from_secs(1) {
        return Vec::new();
    }
    clocks
        .iter()
        .filter_map(|clock| {
            let hwnd = HWND(clock.taskbar as *mut _);
            let mut rect = RECT::default();
            if !unsafe { IsWindowVisible(hwnd) }.as_bool()
                || unsafe { GetWindowRect(hwnd, &mut rect) }.is_err()
                || rect != clock.taskbar_rect
            {
                return None;
            }
            // Clip to the current taskbar so an auto-hidden or moving bar cannot
            // leave an invisible input blocker over the desktop.
            let bounds = RECT {
                left: clock.clock_rect.left.max(rect.left),
                top: clock.clock_rect.top.max(rect.top),
                right: clock.clock_rect.right.min(rect.right),
                bottom: clock.clock_rect.bottom.min(rect.bottom),
            };
            (bounds.left < bounds.right && bounds.top < bounds.bottom).then_some(bounds)
        })
        .collect()
}

fn clock_bounds(automation: &IUIAutomation) -> windows::core::Result<Vec<ClockBounds>> {
    unsafe {
        let all = automation.CreateTrueCondition()?;
        let desktop = automation.GetRootElement()?;
        let windows = desktop.FindAll(TreeScope_Children, &all)?;
        let walker = automation.RawViewWalker()?;
        let mut clocks = Vec::new();
        for index in 0..windows.Length()? {
            let taskbar = windows.GetElement(index)?;
            if !is_taskbar_class(&taskbar.CurrentClassName()?.to_string()) {
                continue;
            }
            let hwnd = taskbar.CurrentNativeWindowHandle()?;
            let mut taskbar_rect = RECT::default();
            GetWindowRect(hwnd, &mut taskbar_rect)?;
            let elements = taskbar.FindAll(TreeScope_Descendants, &all)?;
            for index in 0..elements.Length()? {
                let button = elements.GetElement(index)?;
                let class = button.CurrentClassName()?.to_string();
                if !matches!(
                    class.as_str(),
                    "TrayClockWClass" | "ClockButton" | "SystemTray.OmniButton"
                ) {
                    continue;
                }
                if button.CurrentIsOffscreen()?.as_bool() {
                    continue;
                }
                if class == "SystemTray.OmniButton" {
                    // Quick settings can share the button class. The clock's time
                    // child is locale-independent and only exposed in the raw view.
                    let mut child = walker.GetFirstChildElement(&button);
                    let mut has_time = false;
                    while let Ok(element) = child {
                        if element.CurrentAutomationId()?.to_string() == "TimeInnerTextBlock" {
                            has_time = true;
                            break;
                        }
                        child = walker.GetNextSiblingElement(&element);
                    }
                    if !has_time {
                        continue;
                    }
                }
                clocks.push(ClockBounds {
                    taskbar: hwnd.0 as usize,
                    taskbar_rect,
                    clock_rect: button.CurrentBoundingRectangle()?,
                });
            }
        }
        Ok(clocks)
    }
}

pub(super) fn start_tracking() {
    std::thread::spawn(|| unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        if let Ok(automation) =
            CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        {
            loop {
                let started = Instant::now();
                let clocks = clock_bounds(&automation).unwrap_or_default();
                if let Ok(mut cached) = CLOCKS.write() {
                    let unchanged = cached
                        .as_ref()
                        .map(|(_, previous)| previous.len() == clocks.len()
                            && previous.iter().zip(&clocks).all(|(left, right)| {
                                left.taskbar == right.taskbar
                                    && left.taskbar_rect == right.taskbar_rect
                                    && left.clock_rect == right.clock_rect
                            }))
                        .unwrap_or(false);
                    if unchanged {
                        if let Some((updated, _)) = cached.as_mut() {
                            *updated = started;
                        }
                    } else {
                        *cached = Some((started, clocks));
                    }
                }
                std::thread::sleep(TRACKING_INTERVAL);
            }
        }
        CoUninitialize();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_clock_bounds_are_clickable() {
        let clock = RECT {
            left: 1841,
            top: 1032,
            right: 1904,
            bottom: 1080,
        };
        for point in [POINT { x: 1841, y: 1032 }, POINT { x: 1903, y: 1079 }] {
            assert!(point_in_rect(point, clock));
        }
        // Adjacent network, volume/power, show-desktop and boundary pixels.
        for x in [1785, 1813, 1840, 1904, 1910] {
            assert!(!point_in_rect(POINT { x, y: 1056 }, clock));
        }
        assert!(!point_in_rect(POINT { x: 1860, y: 1031 }, clock));
        assert!(!point_in_rect(POINT { x: 1860, y: 1080 }, clock));
    }

    #[test]
    fn supports_negative_monitor_coordinates_and_empty_bounds() {
        let clock = RECT {
            left: -120,
            top: -48,
            right: -16,
            bottom: 0,
        };
        assert!(point_in_rect(POINT { x: -80, y: -24 }, clock));
        assert!(!point_in_rect(POINT { x: 0, y: 0 }, RECT::default()));
    }

    #[test]
    fn only_taskbar_windows_are_accepted() {
        assert!(is_taskbar_class("Shell_TrayWnd"));
        assert!(is_taskbar_class("Shell_SecondaryTrayWnd"));
        for name in ["Clock", "DateTime", "TrayNotifyWnd", "Shell_TrayWndOther"] {
            assert!(!is_taskbar_class(name));
        }
    }

    #[test]
    #[ignore = "requires a visible Windows 11 taskbar"]
    fn detects_live_clock_without_intercepting_adjacent_controls() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            {
                let automation: IUIAutomation =
                    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).unwrap();
                let clocks = clock_bounds(&automation).unwrap();
                assert!(!clocks.is_empty(), "no visible Windows 11 clock found");
                let rectangles: Vec<_> = clocks.iter().map(|clock| clock.clock_rect).collect();
                *CLOCKS.write().unwrap() = Some((Instant::now(), clocks));
                assert!(!hover_rects().is_empty());
                for rect in rectangles {
                    let point = POINT {
                        x: (rect.left + rect.right) / 2,
                        y: (rect.top + rect.bottom) / 2,
                    };
                    assert!(crate::is_taskbar_clock(point));
                    assert!(!crate::is_taskbar_clock(POINT {
                        x: rect.left - 20,
                        y: point.y
                    }));
                    println!("Clock bounds: {rect:?}");
                }
                let mut cache = CLOCKS.write().unwrap();
                cache.as_mut().unwrap().0 = Instant::now() - Duration::from_secs(2);
                let clock = &cache.as_ref().unwrap().1[0];
                let hwnd = HWND(clock.taskbar as *mut _);
                let point = POINT {
                    x: clock.clock_rect.left,
                    y: clock.clock_rect.top,
                };
                drop(cache);
                assert!(
                    !contains(hwnd, point),
                    "expired bounds must not intercept clicks"
                );
                assert!(
                    hover_rects().is_empty(),
                    "expired bounds must remove hover shields"
                );
                {
                    let mut cache = CLOCKS.write().unwrap();
                    let (updated, clocks) = cache.as_mut().unwrap();
                    *updated = Instant::now();
                    for clock in clocks {
                        clock.taskbar_rect.left -= 1;
                    }
                }
                assert!(
                    hover_rects().is_empty(),
                    "moved taskbars must remove hover shields"
                );
                *CLOCKS.write().unwrap() = None;
                assert!(hover_rects().is_empty());
            }
            CoUninitialize();
        }
    }
}
