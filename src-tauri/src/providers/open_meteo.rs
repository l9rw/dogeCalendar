use serde::Deserialize;

use crate::domain::{CachedWeather, StoredLocation};

const ENDPOINT: &str = "https://api.open-meteo.com/v1/forecast";

#[derive(Debug, Deserialize)]
struct Forecast {
    current: Current,
}

#[derive(Debug, Deserialize)]
struct Current {
    temperature_2m: f64,
    apparent_temperature: Option<f64>,
    relative_humidity_2m: Option<f64>,
    is_day: Option<u8>,
    weather_code: Option<u32>,
    wind_speed_10m: Option<f64>,
}

pub async fn fetch(
    client: &reqwest::Client,
    location: &StoredLocation,
) -> Result<CachedWeather, String> {
    let url = format!(
        "{ENDPOINT}?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&timezone=auto",
        lat = location.latitude,
        lon = location.longitude
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("天气请求失败: {err}"))?;
    let body: Forecast = response
        .json()
        .await
        .map_err(|err| format!("解析天气数据失败: {err}"))?;
    let weather_code = body.current.weather_code.unwrap_or(0);
    let (description, icon) = describe(weather_code, body.current.is_day.unwrap_or(1) == 1);
    Ok(CachedWeather {
        temperature: body.current.temperature_2m,
        apparent_temperature: body.current.apparent_temperature,
        weather_code,
        description,
        icon,
        wind_speed: body.current.wind_speed_10m,
        humidity: body.current.relative_humidity_2m,
        is_day: body.current.is_day.unwrap_or(1) == 1,
        location_label: location.label.clone(),
        fetched_at: chrono::Utc::now().timestamp(),
    })
}

fn describe(code: u32, is_day: bool) -> (String, String) {
    let (text, day_icon, night_icon) = match code {
        0 => ("晴", "sun", "moon"),
        1 => ("多云", "sun-cloud", "moon-cloud"),
        2 => ("局部多云", "sun-cloud", "moon-cloud"),
        3 => ("阴", "cloud", "cloud"),
        45 | 48 => ("有雾", "fog", "fog"),
        51 | 53 | 55 => ("毛毛雨", "drizzle", "drizzle"),
        56 | 57 => ("冻毛毛雨", "rain", "rain"),
        61 | 63 | 65 => ("小雨", "rain", "rain"),
        66 | 67 => ("冻雨", "rain", "rain"),
        71 | 73 | 75 => ("小雪", "snow", "snow"),
        77 => ("米雪", "snow", "snow"),
        80 | 81 | 82 => ("阵雨", "rain", "rain"),
        85 | 86 => ("阵雪", "snow", "snow"),
        95 => ("雷暴", "storm", "storm"),
        96 | 99 => ("雷暴冰雹", "storm", "storm"),
        _ => ("未知", "cloud", "cloud"),
    };
    (text.to_string(), if is_day { day_icon } else { night_icon }.to_string())
}
