use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;

use crate::services::store::Store;

/// Tracks the in-flight weather refresh so it can be de-duplicated and aborted
/// when location/cache/preferences change. A generation counter lets a late
/// result detect that it has been superseded and discard itself instead of
/// overwriting a newer manual location or a freshly cleared cache.
pub struct WeatherTaskSlot {
    handle: Mutex<Option<JoinHandle<()>>>,
    generation: Arc<AtomicU64>,
    cancel: Arc<tokio::sync::Notify>,
}

impl WeatherTaskSlot {
    fn new() -> Self {
        WeatherTaskSlot {
            handle: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            cancel: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Current generation. Captured before a fetch; compared after to detect
    /// that the location/cache/preferences invalidated the in-flight work.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn generation_handle(&self) -> Arc<AtomicU64> {
        self.generation.clone()
    }

    pub fn cancel_notify(&self) -> Arc<tokio::sync::Notify> {
        self.cancel.clone()
    }

    /// Abort any running task, bump the generation, and wake waiters so a
    /// synchronous first-run fetch wrapped in `select!` also aborts promptly.
    pub fn cancel(&self) {
        if let Some(handle) = self
            .handle
            .lock()
            .expect("weather task mutex poisoned")
            .take()
        {
            handle.abort();
        }
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.cancel.notify_waiters();
    }

    /// Register a new background task only when no refresh is in flight, so
    /// repeated focus requests do not abort-and-restart a slow provider (which
    /// would starve it). Returns false (and never calls `spawn`) when the
    /// tracked task has not finished yet. Explicit [`cancel`] still aborts and
    /// clears the slot, so location/cache/preference changes take precedence
    /// over the skip.
    pub fn replace_if_idle<F: FnOnce() -> JoinHandle<()>>(&self, spawn: F) -> bool {
        let mut slot = self.handle.lock().expect("weather task mutex poisoned");
        if let Some(existing) = slot.as_ref() {
            if !existing.inner().is_finished() {
                return false;
            }
        }
        // Previous task already finished; drop its handle without aborting.
        let _ = slot.take();
        *slot = Some(spawn());
        true
    }

    /// True when no task is currently registered (test/diagnostics helper).
    #[allow(dead_code)]
    pub fn is_idle(&self) -> bool {
        self.handle
            .lock()
            .expect("weather task mutex poisoned")
            .is_none()
    }
}

pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
    // Runtime network governance flags, mirrored from StoreData so background
    // tasks and commands can read them without locking the store mutex. Held
    // behind an Arc so spawned background tasks observe live updates.
    weather_enabled: Arc<AtomicBool>,
    network_enabled: Arc<AtomicBool>,
    pub weather_task: WeatherTaskSlot,
    // Last global-shortcut registration error (None when registered cleanly).
    // Surfaced to the UI so a conflict is visible without disabling the app.
    pub global_shortcut_error: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(dir: std::path::PathBuf) -> Self {
        let store = Store::open(dir);
        let (weather_enabled, network_enabled) = {
            let mut data = store.data.lock().expect("store mutex poisoned");
            if data.world_clocks.is_empty() {
                data.world_clocks = crate::services::world_time::default_clocks();
            }
            (data.weather_enabled, data.network_enabled)
        };
        store.persist();
        let store = Arc::new(store);

        let http = reqwest::Client::builder()
            .user_agent("calendar-desktop/0.1")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("failed to build http client");

        AppState {
            store,
            http,
            weather_enabled: Arc::new(AtomicBool::new(weather_enabled)),
            network_enabled: Arc::new(AtomicBool::new(network_enabled)),
            weather_task: WeatherTaskSlot::new(),
            global_shortcut_error: Mutex::new(None),
        }
    }

    pub fn weather_enabled(&self) -> bool {
        self.weather_enabled.load(Ordering::Relaxed)
    }

    pub fn network_enabled(&self) -> bool {
        self.network_enabled.load(Ordering::Relaxed)
    }

    /// Clones suitable for capturing inside spawned background tasks so they can
    /// re-check the live flag immediately before issuing a network request.
    pub fn weather_flag(&self) -> Arc<AtomicBool> {
        self.weather_enabled.clone()
    }

    pub fn network_flag(&self) -> Arc<AtomicBool> {
        self.network_enabled.clone()
    }

    /// Update the runtime flags and persist them only when they actually
    /// change, so periodic frontend syncs do not trigger a full disk rewrite.
    /// Disabling weather/network also aborts any in-flight refresh. Returns
    /// true when the values changed and were persisted.
    pub fn set_runtime_preferences(&self, weather_enabled: bool, network_enabled: bool) -> bool {
        let current_weather = self.weather_enabled();
        let current_network = self.network_enabled();
        if current_weather == weather_enabled && current_network == network_enabled {
            return false;
        }
        self.weather_enabled
            .store(weather_enabled, Ordering::Relaxed);
        self.network_enabled
            .store(network_enabled, Ordering::Relaxed);
        self.store.with(|data| {
            data.weather_enabled = weather_enabled;
            data.network_enabled = network_enabled;
        });
        if !weather_enabled || !network_enabled {
            self.weather_task.cancel();
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tmp_state() -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "calendar-state-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        AppState::new(dir)
    }

    #[test]
    fn defaults_are_enabled() {
        let state = tmp_state();
        assert!(state.weather_enabled(), "weather_enabled defaults to true");
        assert!(state.network_enabled(), "network_enabled defaults to true");
        assert!(state.weather_task.is_idle());
    }

    #[test]
    fn toggling_flags_persists_and_aborts_on_disable() {
        let state = tmp_state();

        // Disabling must persist and cancel any in-flight work.
        let changed = state.set_runtime_preferences(false, false);
        assert!(changed, "disabling should report a change");
        assert!(!state.weather_enabled());
        assert!(!state.network_enabled());
        {
            let data = state.store.data.lock().unwrap();
            assert!(!data.weather_enabled);
            assert!(!data.network_enabled);
        }

        // Re-enabling also persists.
        let changed = state.set_runtime_preferences(true, true);
        assert!(changed);
        assert!(state.weather_enabled());
        assert!(state.network_enabled());

        // Repeatedly setting the same values must NOT report a change (no write).
        let changed = state.set_runtime_preferences(true, true);
        assert!(!changed, "unchanged values should not trigger a write");
    }

    #[tokio::test]
    async fn cancel_aborts_inflight_and_bumps_generation() {
        let state = tmp_state();
        let gen0 = state.weather_task.generation();
        assert!(state.weather_task.is_idle());

        // Register a long-running task that should be aborted on cancel.
        let spawned = state.weather_task.replace_if_idle(|| {
            JoinHandle::Tokio(tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }))
        });
        assert!(spawned);
        assert!(!state.weather_task.is_idle());

        state.weather_task.cancel();
        assert_eq!(state.weather_task.generation(), gen0 + 1);
        assert!(state.weather_task.is_idle());
    }

    #[tokio::test]
    async fn replace_if_idle_skips_while_inflight() {
        let state = tmp_state();
        let gen_before = state.weather_task.generation();

        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));

        let spawned = state.weather_task.replace_if_idle(|| {
            JoinHandle::Tokio(tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }))
        });
        assert!(spawned);
        assert!(!state.weather_task.is_idle());

        // A second registration while the first is still running must be
        // skipped (no abort-restart), so a slow provider is not starved.
        let counter_clone = counter.clone();
        let spawned_again = state.weather_task.replace_if_idle(move || {
            counter_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            JoinHandle::Tokio(tokio::spawn(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }))
        });
        assert!(!spawned_again, "must skip while in flight");
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "must not spawn while in flight"
        );
        assert_eq!(state.weather_task.generation(), gen_before);
        assert!(!state.weather_task.is_idle());

        state.weather_task.cancel();
        assert!(state.weather_task.is_idle());
    }
}
