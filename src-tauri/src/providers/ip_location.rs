use serde::Deserialize;

use crate::domain::StoredLocation;

// Free, key-less HTTPS endpoint that returns city-level coordinates.
// We only keep lat/lon + city/country; the raw IP is never persisted.
const ENDPOINT: &str = "https://ipapi.co/json/";

#[derive(Debug, Deserialize)]
struct IpResponse {
    latitude: Option<f64>,
    longitude: Option<f64>,
    city: Option<String>,
    region: Option<String>,
    country_name: Option<String>,
}

pub async fn resolve(client: &reqwest::Client) -> Result<StoredLocation, String> {
    let response = client
        .get(ENDPOINT)
        .send()
        .await
        .map_err(|err| format!("网络请求失败: {err}"))?;
    let body: IpResponse = response
        .json()
        .await
        .map_err(|err| format!("解析定位数据失败: {err}"))?;
    let latitude = body.latitude.ok_or("缺少纬度")?;
    let longitude = body.longitude.ok_or("缺少经度")?;
    let label = match (body.city.as_ref(), body.country_name.as_ref()) {
        (Some(city), Some(country)) if !city.is_empty() => format!("{city}, {country}"),
        (Some(city), None) if !city.is_empty() => city.clone(),
        (None, Some(country)) => country.clone(),
        _ => body.region.unwrap_or_else(|| "当前位置".to_string()),
    };
    Ok(StoredLocation {
        latitude,
        longitude,
        label,
        source: "ip".to_string(),
    })
}
