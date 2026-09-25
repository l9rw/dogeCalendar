use serde::Deserialize;

use crate::domain::StoredLocation;

// Key-less HTTPS IP geolocation endpoints, tried in order. ipapi.co is now
// behind a Cloudflare JS challenge that blocks non-browser clients, so we
// prefer providers that return plain JSON to a normal HTTP client.
const ENDPOINTS: &[&str] = &[
    "https://ipwho.is/",
    "https://ipinfo.io/json",
    "https://freeipapi.com/api/json/",
];

// Shape returned by ipwho.is / freeipapi.com.
#[derive(Debug, Deserialize)]
struct IpResponse {
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    country_name: Option<String>,
    #[serde(default)]
    capital: Option<String>,
    // ipinfo.io packs coordinates into a "lat,lon" string.
    #[serde(default)]
    loc: Option<String>,
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("网络请求失败 ({url}): {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取响应失败 ({url}): {err}"))?;
    if !status.is_success() {
        let snippet = text.chars().take(120).collect::<String>();
        return Err(format!("定位服务 {url} 返回状态 {status}: {snippet}"));
    }
    Ok(text)
}

fn parse(text: &str) -> Result<StoredLocation, String> {
    let body: IpResponse = serde_json::from_str(text).map_err(|err| {
        let snippet: String = text.chars().take(120).collect();
        format!("解析定位数据失败: {err} (响应: {snippet})")
    })?;

    let (latitude, longitude) = match (body.latitude, body.longitude) {
        (Some(lat), Some(lon)) => (lat, lon),
        _ => {
            // ipinfo.io: loc = "lat,lon".
            let loc = body.loc.as_deref().ok_or("缺少经纬度")?;
            let mut parts = loc.split(',');
            let lat = parts
                .next()
                .ok_or("缺少纬度")?
                .trim()
                .parse::<f64>()
                .map_err(|_| "纬度格式无效")?;
            let lon = parts
                .next()
                .ok_or("缺少经度")?
                .trim()
                .parse::<f64>()
                .map_err(|_| "经度格式无效")?;
            (lat, lon)
        }
    };

    let country_name = body
        .country_name
        .or(body.country)
        .filter(|s| !s.is_empty());
    let city = body.city.filter(|s| !s.is_empty());
    let label = match (city.as_ref(), country_name.as_ref()) {
        (Some(city), Some(country)) => format!("{city}, {country}"),
        (Some(city), None) => city.clone(),
        (None, Some(country)) => country.clone(),
        _ => body
            .region
            .or(body.capital)
            .unwrap_or_else(|| "当前位置".to_string()),
    };

    Ok(StoredLocation {
        latitude,
        longitude,
        label,
        source: "ip".to_string(),
    })
}

pub async fn resolve(client: &reqwest::Client) -> Result<StoredLocation, String> {
    let mut errors = Vec::new();
    for url in ENDPOINTS {
        match fetch(client, url).await {
            Ok(text) => match parse(&text) {
                Ok(loc) => return Ok(loc),
                Err(err) => errors.push(err),
            },
            Err(err) => errors.push(err),
        }
    }
    Err(format!(
        "所有定位服务均失败:\n{}",
        errors.join("\n")
    ))
}
