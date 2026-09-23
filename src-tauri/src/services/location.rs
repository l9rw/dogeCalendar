use crate::domain::StoredLocation;
use crate::providers::ip_location;

pub async fn resolve_location(
    client: &reqwest::Client,
    manual: Option<&StoredLocation>,
) -> Result<StoredLocation, String> {
    if let Some(location) = manual {
        return Ok(location.clone());
    }
    ip_location::resolve(client).await
}

pub fn manual(latitude: f64, longitude: f64, label: String) -> StoredLocation {
    StoredLocation {
        latitude,
        longitude,
        label,
        source: "manual".to_string(),
    }
}
