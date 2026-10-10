use std::collections::HashSet;

use chrono::{Datelike, Local, Offset, TimeZone, Timelike, Utc};
use chrono_tz::{OffsetComponents, Tz};

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

const ENGLISH_CITY_ALIASES: &[(&str, &str)] = &[
    ("Beijing", "北京"),
    ("Shanghai", "上海"),
    ("Hong Kong", "香港"),
    ("Taipei", "台北"),
    ("Tokyo", "东京"),
    ("Seoul", "首尔"),
    ("Singapore", "新加坡"),
    ("Bangkok", "曼谷"),
    ("Jakarta", "雅加达"),
    ("Kuala Lumpur", "吉隆坡"),
    ("Manila", "马尼拉"),
    ("Kolkata", "加尔各答"),
    ("Calcutta", "加尔各答"),
    ("New Delhi", "新德里"),
    ("Mumbai", "孟买"),
    ("Bombay", "孟买"),
    ("Dubai", "迪拜"),
    ("Tehran", "德黑兰"),
    ("Jerusalem", "耶路撒冷"),
    ("Moscow", "莫斯科"),
    ("Istanbul", "伊斯坦布尔"),
    ("Athens", "雅典"),
    ("Berlin", "柏林"),
    ("Frankfurt", "法兰克福"),
    ("Paris", "巴黎"),
    ("Rome", "罗马"),
    ("Madrid", "马德里"),
    ("Amsterdam", "阿姆斯特丹"),
    ("Zurich", "苏黎世"),
    ("London", "伦敦"),
    ("Dublin", "都柏林"),
    ("Reykjavik", "雷克雅未克"),
    ("Cairo", "开罗"),
    ("Johannesburg", "约翰内斯堡"),
    ("Nairobi", "内罗毕"),
    ("New York", "纽约"),
    ("Washington", "华盛顿"),
    ("Toronto", "多伦多"),
    ("Chicago", "芝加哥"),
    ("Mexico City", "墨西哥城"),
    ("Denver", "丹佛"),
    ("Los Angeles", "洛杉矶"),
    ("San Francisco", "旧金山"),
    ("Vancouver", "温哥华"),
    ("Phoenix", "凤凰城"),
    ("Sao Paulo", "圣保罗"),
    ("Buenos Aires", "布宜诺斯艾利斯"),
    ("Honolulu", "檀香山"),
    ("Anchorage", "安克雷奇"),
    ("Sydney", "悉尼"),
    ("Melbourne", "墨尔本"),
    ("Perth", "珀斯"),
    ("Auckland", "奥克兰"),
    ("Fiji", "斐济"),
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
    let query = normalize_search(query);
    if query.is_empty() {
        return list_cities();
    }
    let mut results: Vec<City> = list_cities()
        .into_iter()
        .filter(|city| {
            normalize_search(&city.label).contains(&query)
                || normalize_search(&city.timezone).contains(&query)
                || city
                    .country
                    .as_ref()
                    .map(|country| normalize_search(country).contains(&query))
                    .unwrap_or(false)
                || ENGLISH_CITY_ALIASES.iter().any(|(alias, label)| {
                    city.label == *label && normalize_search(alias).contains(&query)
                })
        })
        .collect();

    let curated_timezones: HashSet<&str> = CITIES.iter().map(|(_, timezone, _)| *timezone).collect();
    let mut generated_timezones = HashSet::new();
    for timezone in chrono_tz::TZ_VARIANTS.iter().copied() {
        let name = timezone.name();
        if !curated_timezones.contains(name)
            && generated_timezones.insert(name)
            && normalize_search(name).contains(&query)
        {
            results.push(City {
                label: name.to_string(),
                timezone: name.to_string(),
                country: None,
            });
        }
    }
    results
}

fn normalize_search(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '_')
        .flat_map(char::to_lowercase)
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

pub fn snapshots_with_local(
    configs: &[WorldClockConfig],
    local_timezone: Option<&str>,
) -> Vec<WorldClockSnapshot> {
    let now = Utc::now();
    let today_local = Local::now().date_naive();
    snapshots_at(configs, local_timezone, now, Some(today_local))
}

fn snapshots_at(
    configs: &[WorldClockConfig],
    local_timezone: Option<&str>,
    now: chrono::DateTime<Utc>,
    today_local: Option<chrono::NaiveDate>,
) -> Vec<WorldClockSnapshot> {
    let mut snapshots = Vec::with_capacity(configs.len() + usize::from(local_timezone.is_some()));
    if let Some(timezone) = local_timezone {
        snapshots.push(build_local_snapshot(timezone, now.clone(), today_local));
    }
    snapshots.extend(configs
        .iter()
        .filter_map(|config| {
            build_snapshot(&config.label, &config.timezone, now.clone(), today_local)
        }));
    snapshots
}

fn build_local_snapshot(
    timezone: &str,
    now: chrono::DateTime<Utc>,
    today_local: Option<chrono::NaiveDate>,
) -> WorldClockSnapshot {
    if let Ok(tz) = timezone.parse::<Tz>() {
        let local = now.with_timezone(&tz);
        let is_dst = local.offset().dst_offset().num_seconds() != 0;
        make_snapshot("local", "local", &local, today_local, Some(is_dst))
    } else {
        build_snapshot("local", "local", now, today_local)
            .expect("the local timezone snapshot is always available")
    }
}

fn build_snapshot(
    label: &str,
    timezone: &str,
    now: chrono::DateTime<Utc>,
    today_local: Option<chrono::NaiveDate>,
) -> Option<WorldClockSnapshot> {
    if timezone.eq_ignore_ascii_case("local") {
        let local = now.with_timezone(&Local);
        Some(make_snapshot(label, "local", &local, today_local, None))
    } else {
        let tz: Tz = timezone.parse().ok()?;
        let local = now.with_timezone(&tz);
        let is_dst = local.offset().dst_offset().num_seconds() != 0;
        Some(make_snapshot(label, timezone, &local, today_local, Some(is_dst)))
    }
}

fn make_snapshot<Tz: TimeZone>(
    label: &str,
    timezone: &str,
    local: &chrono::DateTime<Tz>,
    today_local: Option<chrono::NaiveDate>,
    is_dst: Option<bool>,
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
    let offset_minutes = local.offset().fix().local_minus_utc() / 60;
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
        is_dst,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use chrono::{TimeZone, Utc};

    use super::{build_local_snapshot, build_snapshot, search_cities};
    use crate::domain::WorldClockConfig;

    #[test]
    fn search_normalizes_case_whitespace_and_underscores() {
        let beijing = search_cities("  bEiJiNg  ");
        assert_eq!(beijing.len(), 1);
        assert_eq!(beijing[0].label, "北京");

        let new_delhi = search_cities(" NEW_delhi ");
        assert_eq!(new_delhi.len(), 1);
        assert_eq!(new_delhi[0].label, "新德里");

        let chinese = search_cities("  北京 ");
        assert_eq!(chinese.len(), 1);
        assert_eq!(chinese[0].timezone, "Asia/Shanghai");
    }

    #[test]
    fn search_supports_english_aliases_and_iana_zones() {
        for (alias, label) in [
            ("New Delhi", "新德里"),
            ("San Francisco", "旧金山"),
            ("Washington", "华盛顿"),
            ("Frankfurt", "法兰克福"),
        ] {
            let matches = search_cities(alias);
            assert!(matches.iter().any(|city| city.label == label), "{alias}");
        }

        let curated = search_cities(" europe / berlin ");
        assert_eq!(curated.len(), 2);
        assert!(curated.iter().all(|city| city.timezone == "Europe/Berlin"));

        let generated = search_cities("America/Indiana/Indianapolis");
        assert_eq!(generated.len(), 1);
        assert_eq!(generated[0].label, "America/Indiana/Indianapolis");
        assert_eq!(generated[0].timezone, "America/Indiana/Indianapolis");

        assert!(search_cities("not/a-real-timezone").is_empty());
    }

    #[test]
    fn generated_search_records_do_not_duplicate_timezones() {
        let results = search_cities("america/");
        let generated: Vec<&str> = results
            .iter()
            .filter(|city| city.country.is_none())
            .map(|city| city.timezone.as_str())
            .collect();
        let timezones: HashSet<&str> = generated.iter().copied().collect();
        assert_eq!(timezones.len(), generated.len());
    }

    #[test]
    fn dst_uses_timezone_rules_in_both_hemispheres_and_lord_howe() {
        let winter = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap();
        let summer = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap();
        let snapshot = |timezone: &str, now: &chrono::DateTime<Utc>| {
            build_snapshot("test", timezone, now.clone(), None).expect("valid timezone")
        };

        assert_eq!(snapshot("America/New_York", &winter).is_dst, Some(false));
        assert_eq!(snapshot("America/New_York", &summer).is_dst, Some(true));
        assert_eq!(snapshot("Australia/Sydney", &winter).is_dst, Some(true));
        assert_eq!(snapshot("Australia/Sydney", &summer).is_dst, Some(false));

        let north_before = Utc.with_ymd_and_hms(2026, 3, 8, 6, 59, 0).unwrap();
        let north_after = Utc.with_ymd_and_hms(2026, 3, 8, 7, 0, 0).unwrap();
        assert_eq!(snapshot("America/New_York", &north_before).is_dst, Some(false));
        assert_eq!(snapshot("America/New_York", &north_after).is_dst, Some(true));

        let south_before = Utc.with_ymd_and_hms(2026, 4, 4, 15, 59, 0).unwrap();
        let south_after = Utc.with_ymd_and_hms(2026, 4, 4, 16, 0, 0).unwrap();
        assert_eq!(snapshot("Australia/Sydney", &south_before).is_dst, Some(true));
        assert_eq!(snapshot("Australia/Sydney", &south_after).is_dst, Some(false));

        let lord_howe_summer = snapshot("Australia/Lord_Howe", &winter);
        let lord_howe_winter = snapshot("Australia/Lord_Howe", &summer);
        assert_eq!(lord_howe_summer.is_dst, Some(true));
        assert_eq!(lord_howe_summer.offset_minutes, 660);
        assert_eq!(lord_howe_winter.is_dst, Some(false));
        assert_eq!(lord_howe_winter.offset_minutes, 630);
        let lord_howe_before_end = Utc.with_ymd_and_hms(2026, 4, 4, 14, 59, 0).unwrap();
        let lord_howe_after_end = Utc.with_ymd_and_hms(2026, 4, 4, 15, 0, 0).unwrap();
        assert_eq!(snapshot("Australia/Lord_Howe", &lord_howe_before_end).offset_minutes, 660);
        assert_eq!(snapshot("Australia/Lord_Howe", &lord_howe_after_end).offset_minutes, 630);
        let lord_howe_before_start = Utc.with_ymd_and_hms(2026, 10, 3, 15, 29, 0).unwrap();
        let lord_howe_after_start = Utc.with_ymd_and_hms(2026, 10, 3, 15, 30, 0).unwrap();
        assert_eq!(snapshot("Australia/Lord_Howe", &lord_howe_before_start).offset_minutes, 630);
        assert_eq!(snapshot("Australia/Lord_Howe", &lord_howe_after_start).offset_minutes, 660);
        assert_eq!(snapshot("Asia/Tokyo", &winter).is_dst, Some(false));
    }

    #[test]
    fn optional_local_snapshot_is_prepended_only_when_requested() {
        let now = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap();
        let configs = [WorldClockConfig {
            label: "London".to_string(),
            timezone: "Europe/London".to_string(),
        }];
        let without_local = super::snapshots_at(&configs, None, now.clone(), None);
        assert_eq!(without_local.len(), 1);
        assert_eq!(without_local[0].label, "London");

        let with_local = super::snapshots_at(&configs, Some("Asia/Tokyo"), now, None);
        assert_eq!(with_local.len(), 2);
        assert_eq!(with_local[0].label, "local");
        assert_eq!(with_local[0].timezone, "local");
        assert_eq!(with_local[0].is_dst, Some(false));
        assert_eq!(with_local[1].label, "London");
    }

    #[test]
    fn invalid_local_timezone_falls_back_with_unknown_dst() {
        let now = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap();
        let local = build_local_snapshot("invalid/timezone", now, None);
        assert_eq!(local.label, "local");
        assert_eq!(local.timezone, "local");
        assert_eq!(local.is_dst, None);
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
