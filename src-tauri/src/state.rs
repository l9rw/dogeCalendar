use crate::services::store::Store;

pub struct AppState {
    pub store: Store,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(dir: std::path::PathBuf) -> Self {
        // Surface a default store on first run so users see clocks immediately.
        let store = Store::open(dir);
        {
            let mut data = store.data.lock().expect("store mutex poisoned");
            if data.world_clocks.is_empty() {
                data.world_clocks = crate::services::world_time::default_clocks();
            }
        }
        store.persist();

        let http = reqwest::Client::builder()
            .user_agent("calendar-desktop/0.1")
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("failed to build http client");

        AppState { store, http }
    }
}
