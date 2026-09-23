use chrono::{Datelike, Local, Timelike, Utc};
use chrono_tz::Tz;

use crate::domain::{City, WorldClockConfig, WorldClockSnapshot};

const WEEKDAYS: [&str; 7] = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

const CITIES: &[(&str, &str, &str)] = &[
    ("北京", "Asia/Shanghai", "中国"),
    ("上海", "Asia/Shanghai", "中国"),
    ("香港", "Asia/Hong_Kong", "中国"),
    ("台北", "Asia/Taipei", "中国台湾"),
    ("东京", "Asia/Tokyo", "日本"),
    ("首尔", "Asia/Seoul", "韩国"),
    ("新加坡", "Asia/Singapore", "新加坡"),
    ("曼谷", "Asia/Bangkok", "泰国"),
    ("雅加达", "Asia/Jakarta", "印尼"),
    ("吉隆坡", "Asia/Kuala_Lumpur", "马来西亚"),
    ("马尼拉", "Asia/Manila", "菲律宾"),
    ("加尔各答", "Asia/Kolkata", "印度"),
    ("新德里", "Asia/Kolkata", "印度"),
    ("孟买", "Asia/Kolkata", "印度"),
    ("迪拜", "Asia/Dubai", "阿联酋"),
    ("德黑兰", "Asia/Tehran", "伊朗"),
    ("耶路撒冷", "Asia/Jerusalem", "以色列"),
    ("莫斯科", "Europe/Moscow", "俄罗斯"),
    ("伊斯坦布尔", "Europe/Istanbul", "土耳其"),
    ("雅典", "Europe/Athens", "希腊"),
    ("柏林", "Europe/Berlin", "德国"),
    ("法兰克福", "Europe/Berlin", "德国"),
    ("巴黎", "Europe/Paris", "法国"),
    ("罗马", "Europe/Rome", "意大利"),
    ("马德里", "Europe/Madrid", "西班牙"),
    ("阿姆斯特丹", "Europe/Amsterdam", "荷兰"),
    ("苏黎世", "Europe/Zurich", "瑞士"),
    ("伦敦", "Europe/London", "英国"),
    ("都柏林", "Europe/Dublin", "爱尔兰"),
    ("雷克雅未克", "Atlantic/Reykjavik", "冰岛"),
    ("开罗", "Africa/Cairo", "埃及"),
    ("约翰内斯堡", "Africa/Johannesburg", "南非"),
    ("内罗毕", "Africa/Nairobi", "肯尼亚"),
    ("纽约", "America/New_York", "美国"),
    ("华盛顿", "America/New_York", "美国"),
    ("多伦多", "America/Toronto", "加拿大"),
    ("芝加哥", "America/Chicago", "美国"),
    ("墨西哥城", "America/Mexico_City", "墨西哥"),
    ("丹佛", "America/Denver", "美国"),
    ("洛杉矶", "America/Los_Angeles", "美国"),
    ("旧金山", "America/Los_Angeles", "美国"),
    ("温哥华", "America/Vancouver", "加拿大"),
    ("凤凰城", "America/Phoenix", "美国"),
    ("圣保罗", "America/Sao_Paulo", "巴西"),
    ("布宜诺斯艾利斯", "America/Argentina/Buenos_Aires", "阿根廷"),
    ("檀香山", "Pacific/Honolulu", "美国"),
    ("安克雷奇", "America/Anchorage", "美国"),
    ("悉尼", "Australia/Sydney", "澳大利亚"),
    ("墨尔本", "Australia/Melbourne", "澳大利亚"),
    ("珀斯", "Australia/Perth", "澳大利亚"),
    ("奥克兰", "Pacific/Auckland", "新西兰"),
    ("斐济", "Pacific/Fiji", "斐济"),
];

pub fn list_cities() -> Vec<City> {
    CITIES
        .iter()
        .map(|(label, timezone, country)| City {
            label: label.to_string(),
            timezone: timezone.to_string(),
            country: Some(country.to_string()),
        })
        .collect()
}

pub fn search_cities(query: &str) -> Vec<City> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return list_cities();
    }
    list_cities()
        .into_iter()
        .filter(|city| {
            city.label.to_lowercase().contains(&query)
                || city.timezone.to_lowercase().contains(&query)
                || city
                    .country
                    .as_ref()
                    .map(|country| country.to_lowercase().contains(&query))
                    .unwrap_or(false)
        })
        .collect()
}

pub fn default_clocks() -> Vec<WorldClockConfig> {
    vec![
        WorldClockConfig {
            label: "北京".to_string(),
            timezone: "Asia/Shanghai".to_string(),
        },
        WorldClockConfig {
            label: "伦敦".to_string(),
            timezone: "Europe/London".to_string(),
        },
        WorldClockConfig {
            label: "纽约".to_string(),
            timezone: "America/New_York".to_string(),
        },
    ]
}

pub fn snapshot(config: &WorldClockConfig) -> Option<WorldClockSnapshot> {
    let now = Utc::now();
    let today_local = Local::now().date_naive();
    build_snapshot(&config.label, &config.timezone, now, Some(today_local))
}

pub fn snapshots(configs: &[WorldClockConfig]) -> Vec<WorldClockSnapshot> {
    let now = Utc::now();
    let today_local = Local::now().date_naive();
    configs
        .iter()
        .filter_map(|config| build_snapshot(&config.label, &config.timezone, now, Some(today_local)))
        .collect()
}

fn build_snapshot(
    label: &str,
    timezone: &str,
    now: chrono::DateTime<Utc>,
    today_local: Option<chrono::NaiveDate>,
) -> Option<WorldClockSnapshot> {
    let local = if timezone.eq_ignore_ascii_case("local") {
        let local = now.with_timezone(&Local);
        return Some(make_snapshot(label, "local", &local, today_local));
    } else {
        let tz: Tz = timezone.parse().ok()?;
        now.with_timezone(&tz)
    };
    Some(make_snapshot(label, timezone, &local, today_local))
}

fn make_snapshot(
    label: &str,
    timezone: &str,
    local: &chrono::DateTime<impl chrono::TimeZone>,
    today_local: Option<chrono::NaiveDate>,
) -> WorldClockSnapshot {
    let weekday = WEEKDAYS[local.weekday().num_days_from_sunday() as usize];
    let time_24 = format!("{:02}:{:02}", local.hour(), local.minute());
    let (period, hour12) = to_12h(local.hour());
    let time_12 = format!("{:02}:{:02} {}", hour12, local.minute(), period);
    let date = format!(
        "{}-{:02}-{:02}",
        local.year(),
        local.month(),
        local.day()
    );
    let offset_minutes = offset_minutes_from(&local.format("%z").to_string());
    let offset_label = format_offset(offset_minutes);
    let is_today = today_local
        .map(|today| local.date_naive() == today)
        .unwrap_or(true);
    WorldClockSnapshot {
        label: label.to_string(),
        timezone: timezone.to_string(),
        time_24,
        time_12,
        date,
        weekday: weekday.to_string(),
        offset_label,
        offset_minutes,
        is_today,
    }
}

fn to_12h(hour: u32) -> (&'static str, u32) {
    if hour == 0 {
        ("AM", 12)
    } else if hour < 12 {
        ("AM", hour)
    } else if hour == 12 {
        ("PM", 12)
    } else {
        ("PM", hour - 12)
    }
}

fn offset_minutes_from(value: &str) -> i32 {
    let bytes = value.as_bytes();
    if bytes.len() < 5 {
        return 0;
    }
    let sign = if bytes[0] == b'-' { -1 } else { 1 };
    let hours = (bytes[1] as char).to_digit(10).unwrap_or(0) * 10
        + (bytes[2] as char).to_digit(10).unwrap_or(0);
    let minutes = (bytes[3] as char).to_digit(10).unwrap_or(0) * 10
        + (bytes[4] as char).to_digit(10).unwrap_or(0);
    sign * ((hours as i32) * 60 + minutes as i32)
}

fn format_offset(minutes: i32) -> String {
    let sign = if minutes >= 0 { '+' } else { '-' };
    let total = minutes.abs();
    let hours = total / 60;
    let mins = total % 60;
    if mins == 0 {
        format!("UTC{}{}", sign, hours)
    } else {
        format!("UTC{}{}:{}", sign, hours, mins)
    }
}
