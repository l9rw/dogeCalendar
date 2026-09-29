use windows::{
    core::w,
    Win32::{
        Foundation::{LPARAM, WPARAM},
        Globalization::{GetDateFormatW, GetLocaleInfoW, GetTimeFormatW, SetLocaleInfoW, LOCALE_SSHORTDATE, LOCALE_SSHORTTIME, LOCALE_USER_DEFAULT},
        UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE},
    },
};

fn validate(format: &str) -> Result<(), String> {
    if format.is_empty() || format.encode_utf16().count() >= 80 || format.chars().any(char::is_control) {
        return Err("格式不能为空、包含换行或超过 79 个字符".into());
    }
    let mut quoted = false;
    let mut has_date = false;
    let mut chars = format.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if !quoted && matches!(ch, 'y' | 'M' | 'd') {
            has_date = true;
        } else if !quoted && ch.is_ascii_alphabetic() && ch != 'g' {
            return Err("仅支持 y、M、d、g 日期代码；其他英文文本请用单引号包裹".into());
        }
    }
    if quoted || !has_date {
        return Err("格式需要包含日期代码，且单引号必须成对".into());
    }
    Ok(())
}

fn normalize_date_format(format: &str) -> String {
    let mut normalized = String::with_capacity(format.len());
    let mut quoted = false;
    let mut chars = format.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            normalized.push(ch);
            if chars.peek() == Some(&'\'') {
                normalized.push(chars.next().unwrap());
            } else {
                quoted = !quoted;
            }
        } else if !quoted && matches!(ch, 'Y' | 'D') {
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push(ch);
        }
    }
    normalized
}

fn validate_time(format: &str) -> Result<(), String> {
    if format.is_empty() || format.encode_utf16().count() >= 80 || format.chars().any(char::is_control) {
        return Err("时间格式不能为空、包含换行或超过 79 个字符".into());
    }
    let mut quoted = false;
    let mut has_time = false;
    let mut chars = format.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            if chars.peek() == Some(&'\'') { chars.next(); } else { quoted = !quoted; }
        } else if !quoted && matches!(ch, 'H' | 'h' | 'm' | 's') {
            has_time = true;
        } else if !quoted && ch.is_ascii_alphabetic() && !matches!(ch, 't') {
            return Err("仅支持 H、h、m、s、t 时间代码；其他英文文本请用单引号包裹".into());
        }
    }
    if quoted || !has_time {
        return Err("格式需要包含时间代码，且单引号必须成对".into());
    }
    Ok(())
}

fn get_locale_format(field: u32, label: &str) -> Result<String, String> {
    let size = unsafe { GetLocaleInfoW(LOCALE_USER_DEFAULT, field, None) };
    if size <= 1 { return Err(format!("无法读取 Windows {label}格式")); }
    let mut buffer = vec![0u16; size as usize];
    if unsafe { GetLocaleInfoW(LOCALE_USER_DEFAULT, field, Some(&mut buffer)) } == 0 {
        return Err(format!("无法读取 Windows {label}格式"));
    }
    Ok(String::from_utf16_lossy(&buffer[..buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len())]))
}

fn notify_locale_change() {
    // Locale overrides affect other applications; notify Explorer and all open windows.
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("intl").as_ptr() as isize), SMTO_ABORTIFHUNG, 1000, None);
    }
}

#[tauri::command]
pub fn taskbar_date_format_get() -> Result<String, String> {
    get_locale_format(LOCALE_SSHORTDATE, "短日期")
}

#[tauri::command]
pub fn taskbar_date_format_preview(format: String) -> Result<String, String> {
    let format = normalize_date_format(&format);
    validate(&format)?;
    let wide: Vec<u16> = format.encode_utf16().chain(std::iter::once(0)).collect();
    let size = unsafe { GetDateFormatW(LOCALE_USER_DEFAULT, 0, None, windows::core::PCWSTR(wide.as_ptr()), None) };
    if size <= 1 {
        return Err("Windows 无法解析该日期格式".into());
    }
    let mut buffer = vec![0u16; size as usize];
    if unsafe { GetDateFormatW(LOCALE_USER_DEFAULT, 0, None, windows::core::PCWSTR(wide.as_ptr()), Some(&mut buffer)) } == 0 {
        return Err("Windows 无法解析该日期格式".into());
    }
    Ok(String::from_utf16_lossy(&buffer[..size as usize - 1]))
}

#[tauri::command]
pub fn taskbar_date_format_set(format: String) -> Result<String, String> {
    taskbar_date_format_preview(format.clone())?;
    let format = normalize_date_format(&format);
    let wide: Vec<u16> = format.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SetLocaleInfoW(LOCALE_USER_DEFAULT, LOCALE_SSHORTDATE, windows::core::PCWSTR(wide.as_ptr())) }
        .map_err(|error| format!("修改 Windows 短日期格式失败：{error}"))?;
    notify_locale_change();
    taskbar_date_format_get()
}

#[tauri::command]
pub fn taskbar_time_format_get() -> Result<String, String> {
    get_locale_format(LOCALE_SSHORTTIME, "短时间")
}

#[tauri::command]
pub fn taskbar_time_format_preview(format: String) -> Result<String, String> {
    validate_time(&format)?;
    let wide: Vec<u16> = format.encode_utf16().chain(std::iter::once(0)).collect();
    let size = unsafe { GetTimeFormatW(LOCALE_USER_DEFAULT, 0, None, windows::core::PCWSTR(wide.as_ptr()), None) };
    if size <= 1 { return Err("Windows 无法解析该时间格式".into()); }
    let mut buffer = vec![0u16; size as usize];
    if unsafe { GetTimeFormatW(LOCALE_USER_DEFAULT, 0, None, windows::core::PCWSTR(wide.as_ptr()), Some(&mut buffer)) } == 0 {
        return Err("Windows 无法解析该时间格式".into());
    }
    Ok(String::from_utf16_lossy(&buffer[..size as usize - 1]))
}

#[tauri::command]
pub fn taskbar_time_format_set(format: String) -> Result<String, String> {
    taskbar_time_format_preview(format.clone())?;
    let wide: Vec<u16> = format.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SetLocaleInfoW(LOCALE_USER_DEFAULT, LOCALE_SSHORTTIME, windows::core::PCWSTR(wide.as_ptr())) }
        .map_err(|error| format!("修改 Windows 短时间格式失败：{error}"))?;
    notify_locale_change();
    taskbar_time_format_get()
}

#[cfg(test)]
mod tests {
    use super::{normalize_date_format, taskbar_date_format_preview, taskbar_time_format_preview, validate, validate_time};

    #[test]
    fn accepts_date_patterns_and_quoted_literals() {
        for pattern in ["yyyy/M/d", "yyyy-MM-dd dddd", "M月d日", "'Today:' yyyy/M/d", "yyyy''MM"] {
            assert!(validate(pattern).is_ok(), "{pattern}");
        }
        assert_eq!(normalize_date_format("YY-MM-DD 'DAY'"), "yy-MM-dd 'DAY'");
    }

    #[test]
    fn rejects_invalid_patterns() {
        for pattern in ["", "\nM/d", "HH:mm", "yyyy-MM-dd HH:mm", "'unclosed yyyy", &"d".repeat(80)] {
            assert!(validate(pattern).is_err(), "{pattern}");
        }
    }

    #[test]
    fn previews_with_windows_without_changing_the_system_format() {
        for pattern in ["yyyy/M/d", "yyyy-MM-dd", "yyyy年M月d日", "M月d日 dddd", "YY-MM"] {
            assert!(!taskbar_date_format_preview(pattern.into()).unwrap().is_empty());
        }
    }

    #[test]
    fn time_formats_support_seconds_without_date_tokens() {
        for pattern in ["HH:mm", "HH:mm:ss", "h:mm tt", "'Time' HH:mm"] {
            assert!(validate_time(pattern).is_ok(), "{pattern}");
            assert!(!taskbar_time_format_preview(pattern.into()).unwrap().is_empty());
        }
        for pattern in ["", "YY-MM", "HH:mm\n", "HH:mm LUNAR", "'HH:mm", &"H".repeat(80)] {
            assert!(validate_time(pattern).is_err(), "{pattern}");
        }
    }
}
