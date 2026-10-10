use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::domain::{CountdownRecord, DeliveryResult, NotificationConfig};
use crate::services::countdown as service;
use crate::services::store::Store;
use crate::state::AppState;
use service::SecretStore;

#[derive(Clone)]
pub struct NotificationWorker {
    store: Arc<Store>,
    network_enabled: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
pub struct CountdownEvent {
    pub id: String,
    pub title: String,
    pub target_at: i64,
    pub language: String,
    pub reminded_at: Option<i64>,
    pub delivery_results: Vec<DeliveryResult>,
}

impl From<CountdownRecord> for CountdownEvent {
    fn from(record: CountdownRecord) -> Self {
        Self {
            id: record.id,
            title: record.title,
            target_at: record.target_at,
            language: record.language,
            reminded_at: record.reminded_at,
            delivery_results: record.delivery_results,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NotificationConfigView {
    pub bark_enabled: bool,
    pub bark_server: String,
    pub bark_configured: bool,
    pub serverchan_enabled: bool,
    pub serverchan_configured: bool,
}

#[derive(Debug, Deserialize)]
pub struct NotificationConfigSave {
    bark_enabled: bool,
    bark_server: String,
    serverchan_enabled: bool,
}

#[tauri::command]
pub fn countdown_list(state: State<'_, AppState>) -> Result<Vec<CountdownEvent>, String> {
    let data = state.store.data.lock().map_err(|_| "Store unavailable")?;
    Ok(data.countdowns.iter().cloned().map(Into::into).collect())
}

#[tauri::command]
pub fn countdown_save(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
    title: String,
    target_at: i64,
    language: String,
) -> Result<(), String> {
    let title = title.trim().to_owned();
    service::validate_title(&title)?;
    if language != "zh" && language != "en" {
        return Err("Language must be zh or en".into());
    }
    let now = now_seconds();
    service::validate_target(target_at, now)?;
    let editing = id.is_some();
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    state.store.transaction(|data| {
        if let Some(existing) = data.countdowns.iter_mut().find(|event| event.id == id) {
            let target_changed = existing.target_at != target_at;
            let changed =
                target_changed || existing.title != title || existing.language != language;
            if !changed {
                return Ok(());
            }
            existing.generation = existing.generation.wrapping_add(1);
            existing.title = title;
            existing.language = language;
            existing.target_at = target_at;
            if target_changed {
                existing.reminded_at = None;
                existing.delivery_results.clear();
            } else if existing.reminded_at.is_some() {
                for result in &mut existing.delivery_results {
                    if result.status == "pending" {
                        result.status = "failed:interrupted".into();
                    }
                }
            }
        } else {
            if editing {
                return Err("Countdown event no longer exists".into());
            }
            if data.countdowns.len() >= service::MAX_EVENTS {
                return Err("At most 100 countdown events are allowed".into());
            }
            data.countdowns.push(CountdownRecord {
                id,
                title,
                target_at,
                language,
                reminded_at: None,
                delivery_results: Vec::new(),
                generation: 0,
            });
        }
        Ok(())
    })?;
    let _ = app.emit("countdowns-changed", ());
    Ok(())
}

#[tauri::command]
pub fn countdown_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.store.transaction(|data| {
        data.countdowns.retain(|event| event.id != id);
        Ok(())
    })?;
    let _ = app.emit("countdowns-changed", ());
    Ok(())
}

#[tauri::command]
pub fn notification_config_get(
    state: State<'_, AppState>,
) -> Result<NotificationConfigView, String> {
    let config = {
        let data = state.store.data.lock().map_err(|_| "Store unavailable")?;
        service::config_snapshot(&data)
    };
    let secrets = service::OsSecretStore;
    let bark_configured = secrets.get("bark")?.is_some_and(|key| !key.is_empty());
    let serverchan_configured = secrets
        .get("serverchan")?
        .is_some_and(|key| !key.is_empty());
    Ok(NotificationConfigView {
        bark_enabled: config.bark_enabled,
        bark_server: config.bark_server,
        bark_configured,
        serverchan_enabled: config.serverchan_enabled,
        serverchan_configured,
    })
}

#[tauri::command]
pub fn notification_config_save(
    app: AppHandle,
    state: State<'_, AppState>,
    config: NotificationConfigSave,
    bark_key: Option<String>,
    serverchan_key: Option<String>,
) -> Result<(), String> {
    let mut next = NotificationConfig {
        bark_enabled: config.bark_enabled,
        bark_server: config.bark_server.trim().trim_end_matches('/').to_string(),
        serverchan_enabled: config.serverchan_enabled,
    };
    if next.bark_server.is_empty() {
        next.bark_server = "https://api.day.app".into();
    }
    service::parse_bark_server(&next.bark_server)?;
    if bark_key
        .as_ref()
        .is_some_and(|key| key.len() > 512 || key.chars().any(char::is_control))
    {
        return Err("Invalid Bark device key".into());
    }

    let secrets = service::OsSecretStore;
    let old_bark = secrets.get("bark")?;
    let old_chan = secrets.get("serverchan")?;
    let new_bark = match bark_key.as_deref() {
        Some("") => None,
        Some(key) => Some(key),
        None => old_bark.as_deref(),
    };
    let new_chan = match serverchan_key.as_deref() {
        Some("") => None,
        Some(key) => Some(key),
        None => old_chan.as_deref(),
    };
    if next.bark_enabled && new_bark.is_none_or(str::is_empty) {
        return Err("Bark is enabled but no device key is configured".into());
    }
    if next.serverchan_enabled {
        let key = new_chan.ok_or("ServerChan is enabled but no SendKey is configured")?;
        service::parse_serverchan_key(key)?;
    }
    if let Some(key) = new_chan {
        if !key.is_empty() {
            service::parse_serverchan_key(key)?;
        }
    }

    let update_bark = bark_key.is_some();
    let update_chan = serverchan_key.is_some();
    if update_bark {
        if let Err(error) = secrets.set("bark", new_bark) {
            return Err(error);
        }
    }
    if update_chan {
        if let Err(error) = secrets.set("serverchan", new_chan) {
            if update_bark {
                let _ = secrets.set("bark", old_bark.as_deref());
            }
            return Err(error);
        }
    }
    if let Err(error) = state.store.transaction(|data| {
        data.notification_config = next;
        Ok(())
    }) {
        let _ = secrets.set("bark", old_bark.as_deref());
        let _ = secrets.set("serverchan", old_chan.as_deref());
        return Err(error);
    }
    let _ = app.emit("countdowns-changed", ());
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationChannel {
    System,
    Bark,
    Serverchan,
}

#[tauri::command]
pub async fn notification_test(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: NotificationChannel,
    language: String,
) -> Result<(), String> {
    if language != "zh" && language != "en" {
        return Err("Language must be zh or en".into());
    }
    let title = if language == "zh" {
        "倒计时测试"
    } else {
        "Countdown test"
    };
    let body = if language == "zh" {
        "这是一条测试提醒。"
    } else {
        "This is a test reminder."
    };
    match channel {
        NotificationChannel::System => show_system_notification(&app, title, body),
        NotificationChannel::Bark => {
            if !state.network_enabled() {
                return Err("Network access is disabled".into());
            }
            let config = config(&state)?;
            if !config.bark_enabled {
                return Err("Bark channel is disabled".into());
            }
            let key = service::OsSecretStore
                .get("bark")?
                .filter(|key| !key.is_empty())
                .ok_or("Bark device key is not configured")?;
            let client = service::make_client()?;
            if !state.network_enabled() {
                return Err("Network access is disabled".into());
            }
            service::send_bark(&client, &config.bark_server, &key, title, body)
                .await
                .map_err(|error| service::failure_status(&error))
        }
        NotificationChannel::Serverchan => {
            if !state.network_enabled() {
                return Err("Network access is disabled".into());
            }
            let config = config(&state)?;
            if !config.serverchan_enabled {
                return Err("ServerChan channel is disabled".into());
            }
            let key = service::OsSecretStore
                .get("serverchan")?
                .filter(|key| !key.is_empty())
                .ok_or("ServerChan SendKey is not configured")?;
            let client = service::make_client()?;
            if !state.network_enabled() {
                return Err("Network access is disabled".into());
            }
            service::send_serverchan(&client, &key, title, body)
                .await
                .map_err(|error| service::failure_status(&error))
        }
    }
}

fn config(state: &State<'_, AppState>) -> Result<NotificationConfig, String> {
    state
        .store
        .data
        .lock()
        .map(|data| data.notification_config.clone())
        .map_err(|_| "Store unavailable".into())
}

pub fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

pub fn show_system_notification(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    match app
        .notification()
        .permission_state()
        .map_err(|_| "Could not check system notification permission")?
    {
        PermissionState::Granted => app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|_| "System notification failed".into()),
        _ => Err("System notification permission denied".into()),
    }
}

pub fn dispatch_claimed(app: AppHandle, worker: NotificationWorker, event: CountdownRecord) {
    let Some(reminded_at) = event.reminded_at else {
        return;
    };
    let generation = event.generation;
    let id = event.id.clone();
    let title = event.title.clone();
    let language = event.language.clone();
    let body = service::format_reminder_body(&language, event.target_at);
    let network_enabled = worker.network_enabled.clone();
    let config = worker
        .store
        .data
        .lock()
        .ok()
        .map(|data| data.notification_config.clone());
    let app_for_send = app.clone();

    tauri::async_runtime::spawn(async move {
        let app_for_native = app_for_send.clone();
        let native_store = worker.store.clone();
        let native_event = event.clone();
        let native_title = title.clone();
        let native_body = body.clone();
        let native_task = tauri::async_runtime::spawn_blocking(move || {
            if !service::claim_is_current(&native_store, &native_event)
                || native_event.target_at <= now_seconds()
            {
                return Err("failed:interrupted".into());
            }
            show_system_notification(&app_for_native, &native_title, &native_body)
        });

        let Some(config) = config else {
            let native = native_task
                .await
                .unwrap_or_else(|_| Err("System notification failed".into()));
            persist_delivery(
                &app_for_send,
                &worker.store,
                &id,
                generation,
                reminded_at,
                "system",
                native,
            );
            return;
        };
        if config.bark_enabled || config.serverchan_enabled {
            let client = service::make_client();
            let (bark_result, chan_result) = tokio::join!(
                async {
                    if config.bark_enabled {
                        Some(
                            send_remote(
                                "bark",
                                &client,
                                &config,
                                &title,
                                &body,
                                &network_enabled,
                                &worker.store,
                                &event,
                            )
                            .await,
                        )
                    } else {
                        None
                    }
                },
                async {
                    if config.serverchan_enabled {
                        Some(
                            send_remote(
                                "serverchan",
                                &client,
                                &config,
                                &title,
                                &body,
                                &network_enabled,
                                &worker.store,
                                &event,
                            )
                            .await,
                        )
                    } else {
                        None
                    }
                }
            );
            if let Some(result) = bark_result {
                persist_delivery(
                    &app_for_send,
                    &worker.store,
                    &id,
                    generation,
                    reminded_at,
                    "bark",
                    result,
                );
            }
            if let Some(result) = chan_result {
                persist_delivery(
                    &app_for_send,
                    &worker.store,
                    &id,
                    generation,
                    reminded_at,
                    "serverchan",
                    result,
                );
            }
        }
        let native = native_task
            .await
            .unwrap_or_else(|_| Err("System notification failed".into()));
        persist_delivery(
            &app_for_send,
            &worker.store,
            &id,
            generation,
            reminded_at,
            "system",
            native,
        );
    });
}

async fn send_remote(
    channel: &str,
    client: &Result<reqwest::Client, String>,
    config: &NotificationConfig,
    title: &str,
    body: &str,
    network_enabled: &Arc<AtomicBool>,
    store: &Store,
    event: &CountdownRecord,
) -> Result<(), String> {
    if !network_enabled.load(Ordering::Relaxed) {
        return Err("Network access is disabled".into());
    }
    let client = client.as_ref().map_err(Clone::clone)?;
    let key = service::OsSecretStore
        .get(channel)?
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            if channel == "bark" {
                "Bark device key is not configured"
            } else {
                "ServerChan SendKey is not configured"
            }
            .to_string()
        })?;
    if !service::claim_is_current(store, event) || event.target_at <= now_seconds() {
        return Err("failed:interrupted".into());
    }
    if !network_enabled.load(Ordering::Relaxed) {
        return Err("Network access is disabled".into());
    }
    if channel == "bark" {
        service::send_bark(client, &config.bark_server, &key, title, body).await
    } else {
        service::send_serverchan(client, &key, title, body).await
    }
}

fn persist_delivery(
    app: &AppHandle,
    store: &Arc<Store>,
    id: &str,
    generation: u64,
    reminded_at: i64,
    channel: &str,
    result: Result<(), String>,
) {
    let status = result
        .map(|_| "sent".to_string())
        .unwrap_or_else(|error| service::failure_status(&error));
    let changed = service::record_result(
        store,
        id,
        generation,
        reminded_at,
        DeliveryResult {
            channel: channel.into(),
            status,
        },
    );
    if changed.is_ok_and(|changed| changed) {
        let _ = app.emit("countdowns-changed", ());
    }
}

pub fn start_scheduler(app: AppHandle, store: Arc<Store>) {
    tauri::async_runtime::spawn(async move {
        match service::reconcile_interrupted(&store) {
            Ok(true) => {
                let _ = app.emit("countdowns-changed", ());
            }
            Ok(false) => {}
            Err(error) => {
                eprintln!("calendar: could not reconcile interrupted countdown delivery: {error}")
            }
        }
        loop {
            let now = now_seconds();
            match service::claim_due(&store, now) {
                Ok(events) => {
                    if !events.is_empty() {
                        let _ = app.emit("countdowns-changed", ());
                    }
                    for event in events {
                        let state = app.state::<AppState>();
                        let snapshot = NotificationWorker {
                            store: store.clone(),
                            network_enabled: state.network_flag(),
                        };
                        dispatch_claimed(app.clone(), snapshot, event);
                    }
                }
                Err(error) => {
                    eprintln!("calendar: countdown claim could not be persisted: {error}")
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    });
}
