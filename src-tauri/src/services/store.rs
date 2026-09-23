use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::domain::StoreData;

const STORE_FILE: &str = "calendar-data.json";

pub struct Store {
    pub data: Mutex<StoreData>,
    pub dir: PathBuf,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let data = load(&dir.join(STORE_FILE));
        Store {
            data: Mutex::new(data),
            dir,
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(STORE_FILE)
    }

    pub fn persist(&self) {
        if let Ok(data) = self.data.lock() {
            let _ = write(&self.path(), &data);
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut StoreData) -> R) -> R {
        let mut data = self.data.lock().expect("store mutex poisoned");
        let result = f(&mut data);
        let _ = write(&self.path(), &data);
        result
    }
}

fn load(path: &Path) -> StoreData {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| serde_json::from_str("{}").unwrap_or_default()),
        Err(_) => serde_json::from_str("{}").unwrap_or_default(),
    }
}

fn write(path: &Path, data: &StoreData) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(data)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)
}
