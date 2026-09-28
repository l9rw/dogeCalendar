use serde::Deserialize;

// Keyless reverse-geocoding endpoint. `localityLanguage` controls the
// language of the returned locality/country names so the weather location
// label follows the app's configured language.
const ENDPOINT: &str = "https://api.bigdatacloud.net/data/reverse-geocode-client";

#[derive(Debug, Deserialize)]
struct ReverseResponse {
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    locality: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "principalSubdivision")]
    principal_subdivision: Option<String>,
    #[serde(default, rename = "countryName")]
    country_name: Option<String>,
}

pub async fn resolve_label(
    client: &reqwest::Client,
    latitude: f64,
    longitude: f64,
    language: &str,
) -> Result<String, String> {
    let url = format!(
        "{ENDPOINT}?latitude={lat}&longitude={lon}&localityLanguage={lang}",
        lat = latitude,
        lon = longitude,
        lang = language
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("反向定位请求失败: {err}"))?;
    let body: ReverseResponse = response
        .json()
        .await
        .map_err(|err| format!("解析反向定位数据失败: {err}"))?;

    let city = body
        .city
        .or(body.locality)
        .or(body.name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let country = body
        .country_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let label = match (city, country) {
        (Some(city), Some(country)) => format!("{city}, {country}"),
        (Some(city), None) => city,
        (None, Some(country)) => country,
        _ => body
            .principal_subdivision
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "当前位置".to_string()),
    };
    Ok(label)
}
