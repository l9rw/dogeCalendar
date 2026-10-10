use std::time::Duration;

use keyring::Entry;
use reqwest::{redirect::Policy, Client, Url};
use serde::Deserialize;
use serde_json::json;

use crate::domain::{CountdownRecord, DeliveryResult, NotificationConfig, StoreData};
use crate::services::store::Store;

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String>;
}

#[derive(Clone, Copy)]
pub struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        read_key(name)
    }

    fn set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        write_key(name, value)
    }
}

const SERVICE: &str = "dogeCalendar.countdown";
pub const MAX_EVENTS: usize = 100;
const REMINDER_LEAD_SECONDS: i64 = 60;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub fn credential(service: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, service).map_err(|_| "Credential store unavailable".to_string())
}

pub fn read_key(service: &str) -> Result<Option<String>, String> {
    match credential(service)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Credential store unavailable".into()),
    }
}

pub fn write_key(service: &str, value: Option<&str>) -> Result<(), String> {
    let entry = credential(service)?;
    match value {
        Some(value) if !value.is_empty() => entry
            .set_password(value)
            .map_err(|_| "Could not save credential".to_string()),
        _ => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not clear credential".into()),
        },
    }
}

pub fn validate_title(title: &str) -> Result<(), String> {
    let count = title.chars().count();
    if count == 0 || count > 100 || title.trim().is_empty() {
        return Err("Title must contain 1 to 100 characters".into());
    }
    Ok(())
}

pub fn validate_target(target_at: i64, now: i64) -> Result<(), String> {
    if target_at <= now || target_at > 253_402_300_799 {
        return Err("Target time must be in the future and no later than year 9999".into());
    }
    Ok(())
}

pub fn parse_bark_server(server: &str) -> Result<Url, String> {
    let server = server.trim().trim_end_matches('/');
    let parsed =
        Url::parse(server).map_err(|_| "Bark server must be a valid HTTPS URL".to_string())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Bark server must be a valid HTTPS URL without credentials or query".into());
    }
    Ok(parsed)
}

pub fn bark_url(server: &str) -> Result<Url, String> {
    let mut url = parse_bark_server(server)?;
    url.set_path(&format!("{}/push", url.path().trim_end_matches('/')));
    Ok(url)
}

pub fn parse_serverchan_key(key: &str) -> Result<String, String> {
    if key.len() > 512 {
        return Err("Invalid ServerChan 3 SendKey".into());
    }
    let Some(rest) = key.strip_prefix("sctp") else {
        return Err("ServerChan SendKey must begin with sctp".into());
    };
    let uid: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if uid.is_empty()
        || uid.len() > 20
        || rest
            .get(uid.len()..)
            .is_none_or(|tail| tail.strip_prefix('t').is_none_or(str::is_empty))
    {
        return Err("Invalid ServerChan 3 SendKey".into());
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid ServerChan 3 SendKey".into());
    }
    Ok(uid)
}

pub fn serverchan_url(key: &str) -> Result<Url, String> {
    let uid = parse_serverchan_key(key)?;
    Url::parse(&format!("https://{uid}.push.ft07.com/send/{key}.send"))
        .map_err(|_| "Invalid ServerChan 3 SendKey".to_string())
}

#[derive(Deserialize)]
struct BarkResponse {
    code: Option<i64>,
}

pub fn bark_success(body: &[u8]) -> bool {
    serde_json::from_slice::<BarkResponse>(body)
        .ok()
        .and_then(|value| value.code)
        == Some(200)
}

pub fn provider_success(status: reqwest::StatusCode, provider: &str, body: &[u8]) -> bool {
    if !status.is_success() {
        return false;
    }
    if provider == "bark" {
        bark_success(body)
    } else {
        provider == "serverchan"
    }
}

pub fn make_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .redirect(Policy::none())
        .user_agent("dogeCalendar/0.1")
        .build()
        .map_err(|_| "Could not initialize notification network client".into())
}

pub async fn send_bark(
    client: &Client,
    server: &str,
    key: &str,
    title: &str,
    body: &str,
) -> Result<(), String> {
    let url = bark_url(server)?;
    let response = client
        .post(url)
        .json(&json!({ "device_key": key, "title": title, "body": body }))
        .send()
        .await
        .map_err(|error| network_error(&error))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let bytes = read_response_bounded(response).await?;
    if provider_success(status, "bark", &bytes) {
        Ok(())
    } else {
        Err("Provider rejected the request".into())
    }
}

pub async fn send_serverchan(
    client: &Client,
    key: &str,
    title: &str,
    body: &str,
) -> Result<(), String> {
    let url = serverchan_url(key)?;
    let response = client
        .post(url)
        .json(&json!({ "title": title, "desp": body }))
        .send()
        .await
        .map_err(|error| network_error(&error))?;
    let status = response.status();
    // ServerChan 3 defines acceptance by the HTTP status; do not parse/drain the body.
    if status.is_success() {
        Ok(())
    } else {
        Err("Provider rejected the request".into())
    }
}

async fn read_response_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Invalid provider response".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Invalid provider response")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Invalid provider response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn config_snapshot(data: &StoreData) -> NotificationConfig {
    data.notification_config.clone()
}

pub fn should_claim(event: &CountdownRecord, now: i64) -> bool {
    event.reminded_at.is_none()
        && event.target_at > now
        && event.target_at.saturating_sub(now) <= REMINDER_LEAD_SECONDS
}

pub fn claim_is_current(store: &Store, claimed: &CountdownRecord) -> bool {
    store.data.lock().ok().is_some_and(|data| {
        data.countdowns.iter().any(|event| {
            event.id == claimed.id
                && event.generation == claimed.generation
                && event.reminded_at == claimed.reminded_at
                && claimed.reminded_at.is_some()
        })
    })
}

pub fn claim_due(store: &Store, now: i64) -> Result<Vec<CountdownRecord>, String> {
    let has_due = {
        let data = store.data.lock().map_err(|_| "Store unavailable")?;
        data.countdowns.iter().any(|event| should_claim(event, now))
    };
    if !has_due {
        return Ok(Vec::new());
    }
    let due = store.transaction(|data| {
        let config = data.notification_config.clone();
        let claimed = data
            .countdowns
            .iter_mut()
            .filter(|event| should_claim(event, now))
            .map(|event| {
                event.reminded_at = Some(now);
                event.delivery_results.clear();
                event.delivery_results.push(DeliveryResult {
                    channel: "system".into(),
                    status: "pending".into(),
                });
                if config.bark_enabled {
                    event.delivery_results.push(DeliveryResult {
                        channel: "bark".into(),
                        status: "pending".into(),
                    });
                }
                if config.serverchan_enabled {
                    event.delivery_results.push(DeliveryResult {
                        channel: "serverchan".into(),
                        status: "pending".into(),
                    });
                }
                event.clone()
            })
            .collect::<Vec<_>>();
        Ok(claimed)
    })?;
    Ok(due)
}

pub fn reconcile_interrupted(store: &Store) -> Result<bool, String> {
    let pending = {
        let data = store.data.lock().map_err(|_| "Store unavailable")?;
        data.countdowns.iter().any(|event| {
            event
                .delivery_results
                .iter()
                .any(|result| result.status == "pending")
        })
    };
    if !pending {
        return Ok(false);
    }
    store.transaction(|data| {
        let mut changed = false;
        for event in &mut data.countdowns {
            for result in &mut event.delivery_results {
                if result.status == "pending" {
                    result.status = "failed:interrupted".into();
                    changed = true;
                }
            }
        }
        Ok(changed)
    })
}

pub fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "failed:timeout".into()
    } else {
        "failed:network".into()
    }
}

pub fn record_result(
    store: &Store,
    id: &str,
    generation: u64,
    reminded_at: i64,
    result: DeliveryResult,
) -> Result<bool, String> {
    let current = {
        let data = store.data.lock().map_err(|_| "Store unavailable")?;
        data.countdowns
            .iter()
            .find(|event| event.id == id)
            .is_some_and(|event| {
                event.generation == generation && event.reminded_at == Some(reminded_at)
            })
    };
    if !current {
        return Ok(false);
    }
    store.transaction(|data| {
        let Some(event) = data.countdowns.iter_mut().find(|event| event.id == id) else {
            return Ok(false);
        };
        if event.generation != generation || event.reminded_at != Some(reminded_at) {
            return Ok(false);
        }
        event
            .delivery_results
            .retain(|old| old.channel != result.channel);
        event.delivery_results.push(result);
        Ok(true)
    })
}

pub fn failure_status(error: &str) -> String {
    match error {
        "System notification permission denied" => "failed:permission_denied".into(),
        "Credential store unavailable"
        | "Bark device key is not configured"
        | "ServerChan SendKey is not configured" => "failed:credentials".into(),
        "Provider rejected the request" | "Invalid provider response" | "failed:http" => {
            "failed:api".into()
        }
        "Network access is disabled" => "network_disabled".into(),
        "Network request failed" | "failed:network" => "failed:network".into(),
        "failed:timeout" => "failed:timeout".into(),
        "failed:interrupted" => "failed:interrupted".into(),
        _ => "failed:configuration".into(),
    }
}

pub fn format_reminder_body(language: &str, target_at: i64) -> String {
    use chrono::{Local, TimeZone};
    let display = Local
        .timestamp_opt(target_at, 0)
        .single()
        .map(|date| date.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| target_at.to_string());
    if language == "zh" {
        format!("事件将在 {display} 开始")
    } else {
        format!("Event starts at {display}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn claim_boundary_skips_expired_and_claims_within_last_minute() {
        let mut event = CountdownRecord {
            id: "id".into(),
            title: "test".into(),
            target_at: 1060,
            language: "en".into(),
            reminded_at: None,
            delivery_results: Vec::new(),
            generation: 0,
        };
        assert!(!should_claim(&event, 999));
        assert!(should_claim(&event, 1000));
        assert!(should_claim(&event, 1059));
        assert!(!should_claim(&event, 1060));
        event.reminded_at = Some(1000);
        assert!(!should_claim(&event, 1001));
    }

    fn temp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "countdown-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        (Store::open(dir.clone()), dir)
    }

    #[test]
    fn claims_are_persisted_once_and_late_results_are_guarded() {
        let (store, dir) = temp_store();
        store
            .transaction(|data| {
                data.countdowns.push(CountdownRecord {
                    id: "a".into(),
                    title: "A".into(),
                    target_at: 1060,
                    language: "en".into(),
                    reminded_at: None,
                    delivery_results: Vec::new(),
                    generation: 1,
                });
                Ok(())
            })
            .unwrap();

        let claimed = claim_due(&store, 1000).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].reminded_at, Some(1000));
        assert_eq!(claimed[0].delivery_results[0].status, "pending");
        assert!(claim_is_current(&store, &claimed[0]));
        assert!(claim_due(&store, 1001).unwrap().is_empty());
        assert!(record_result(
            &store,
            "a",
            1,
            1000,
            DeliveryResult {
                channel: "system".into(),
                status: "sent".into()
            }
        )
        .unwrap());
        assert!(!record_result(
            &store,
            "deleted",
            1,
            1000,
            DeliveryResult {
                channel: "system".into(),
                status: "sent".into()
            }
        )
        .unwrap());

        store
            .transaction(|data| {
                let event = &mut data.countdowns[0];
                event.generation += 1;
                event.reminded_at = Some(2000);
                Ok(())
            })
            .unwrap();
        assert!(!claim_is_current(&store, &claimed[0]));
        assert!(!record_result(
            &store,
            "a",
            1,
            1000,
            DeliveryResult {
                channel: "system".into(),
                status: "sent".into()
            }
        )
        .unwrap());
        assert!(record_result(
            &store,
            "a",
            2,
            2000,
            DeliveryResult {
                channel: "bark".into(),
                status: "sent".into()
            }
        )
        .unwrap());
        let current = store.data.lock().unwrap().countdowns[0].clone();
        assert!(claim_is_current(&store, &current));
        store
            .transaction(|data| {
                data.countdowns.clear();
                Ok(())
            })
            .unwrap();
        assert!(!claim_is_current(&store, &current));
        assert!(!record_result(
            &store,
            "a",
            2,
            2000,
            DeliveryResult {
                channel: "bark".into(),
                status: "sent".into()
            }
        )
        .unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn claimed_reminder_survives_restart_without_redelivery() {
        let (store, dir) = temp_store();
        store
            .transaction(|data| {
                data.countdowns.push(CountdownRecord {
                    id: "restart".into(),
                    title: "Restart".into(),
                    target_at: 1060,
                    language: "zh".into(),
                    reminded_at: None,
                    delivery_results: Vec::new(),
                    generation: 0,
                });
                Ok(())
            })
            .unwrap();
        claim_due(&store, 1000).unwrap();
        drop(store);
        let reopened = Store::open(dir.clone());
        assert!(reconcile_interrupted(&reopened).unwrap());
        assert_eq!(
            reopened.data.lock().unwrap().countdowns[0].delivery_results[0].status,
            "failed:interrupted"
        );
        assert!(claim_due(&reopened, 1001).unwrap().is_empty());
        assert_eq!(
            reopened.data.lock().unwrap().countdowns[0].reminded_at,
            Some(1000)
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_reconciliation_does_not_persist_when_idle() {
        let (store, dir) = temp_store();
        assert!(!reconcile_interrupted(&store).unwrap());
        assert!(claim_due(&store, 1000).unwrap().is_empty());
        assert!(!dir.join("calendar-data.json").exists());
        store.transaction(|data| {
            data.countdowns.push(CountdownRecord {
                id: "pending".into(), title: "Pending".into(), target_at: 1060, language: "en".into(),
                reminded_at: Some(1000), generation: 0,
                delivery_results: vec![DeliveryResult { channel: "system".into(), status: "pending".into() }],
            });
            Ok(())
        }).unwrap();
        assert!(reconcile_interrupted(&store).unwrap());
        assert_eq!(store.data.lock().unwrap().countdowns[0].delivery_results[0].status, "failed:interrupted");
        assert!(!reconcile_interrupted(&store).unwrap());
        assert!(claim_due(&store, 1001).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn response_success_requires_http_ok_and_provider_success_shape() {
        assert!(provider_success(
            reqwest::StatusCode::OK,
            "serverchan",
            br#"{"code":0,"message":"SUCCESS"}"#
        ));
        assert!(provider_success(
            reqwest::StatusCode::OK,
            "serverchan",
            b"not json"
        ));
        assert!(provider_success(
            reqwest::StatusCode::NO_CONTENT,
            "serverchan",
            b""
        ));
        assert!(!provider_success(
            reqwest::StatusCode::BAD_REQUEST,
            "serverchan",
            b"{}"
        ));
        assert!(provider_success(
            reqwest::StatusCode::OK,
            "bark",
            br#"{"code":200}"#
        ));
        assert!(!provider_success(
            reqwest::StatusCode::OK,
            "bark",
            br#"{"code":0}"#
        ));
    }

    #[test]
    fn provider_urls_reject_non_https_and_never_follow_key_redirects() {
        assert_eq!(
            bark_url("https://bark.example/base/").unwrap().as_str(),
            "https://bark.example/base/push"
        );
        assert!(parse_bark_server("http://bark.example").is_err());
        assert_eq!(
            serverchan_url("sctp123tAbCd").unwrap().as_str(),
            "https://123.push.ft07.com/send/sctp123tAbCd.send"
        );
        assert!(serverchan_url("SCT123tbad").is_err());
    }

    #[test]
    fn response_parsing_requires_documented_success_fields() {
        assert!(bark_success(br#"{"code":200}"#));
        assert!(!bark_success(br#"{"code":400}"#));
        assert!(provider_success(
            reqwest::StatusCode::OK,
            "serverchan",
            br#"{"code":0}"#
        ));
        assert!(provider_success(
            reqwest::StatusCode::OK,
            "serverchan",
            br#"{"code":1}"#
        ));
        assert!(!provider_success(
            reqwest::StatusCode::BAD_REQUEST,
            "serverchan",
            br#"{"code":0}"#
        ));
    }

    #[test]
    fn validation_and_result_statuses_do_not_contain_secrets() {
        assert!(validate_title(" ").is_err());
        assert!(validate_title(&"x".repeat(101)).is_err());
        assert!(validate_title(&"x".repeat(100)).is_ok());
        assert!(validate_target(10, 10).is_err());
        assert!(validate_target(i64::MAX, 10).is_err());
        assert!(validate_target(253_402_300_799, 10).is_ok());
        let url = serverchan_url("sctp123tSECRET").unwrap();
        assert!(url.as_str().contains("SECRET"));
        let result = DeliveryResult {
            channel: "serverchan".into(),
            status: "failed:Provider rejected the request".into(),
        };
        assert!(!result.status.contains("SECRET"));
    }

    #[test]
    fn disabled_network_and_delivery_failures_map_to_frontend_status_codes() {
        assert_eq!(
            failure_status("Network access is disabled"),
            "network_disabled"
        );
        assert_eq!(
            failure_status("System notification permission denied"),
            "failed:permission_denied"
        );
        assert_eq!(
            failure_status("Credential store unavailable"),
            "failed:credentials"
        );
        assert_eq!(failure_status("failed:timeout"), "failed:timeout");
        assert_eq!(failure_status("failed:http"), "failed:api");
        assert_eq!(failure_status("failed:network"), "failed:network");
    }

    #[test]
    fn old_countdown_fields_default_and_default_config_is_https() {
        let old: StoreData = serde_json::from_str(r#"{"world_clocks":[]}"#).unwrap();
        assert!(old.countdowns.is_empty());
        assert!(!old.notification_config.bark_enabled);
        assert!(!old.notification_config.serverchan_enabled);
        assert_eq!(old.notification_config.bark_server, "https://api.day.app");
        let serialized = serde_json::to_string(&old).unwrap();
        assert!(!serialized.contains("bark_key"));
        assert!(!serialized.contains("serverchan_key"));
        assert!(!serialized.contains("sendkey"));
    }
}
