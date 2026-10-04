use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::domain::StoreData;

const STORE_FILE: &str = "calendar-data.json";
const BACKUP_FILE: &str = "calendar-data.json.bak";
const TMP_FILE: &str = "calendar-data.json.tmp";
const BACKUP_TMP_FILE: &str = "calendar-data.json.bak.tmp";

/// High-level outcome of the last store load, surfaced to the UI so a corrupt
/// main file or a disabled-write state is visible instead of silent data loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreStatus {
    /// No main or backup file existed; in-memory defaults only.
    Fresh,
    /// Main file loaded and parsed cleanly.
    Ok,
    /// Main was missing or corrupt but a valid backup was restored; the corrupt
    /// main (when present) was moved to quarantine so it can be inspected.
    RecoveredFromBackup,
    /// Main and/or backup were corrupt; defaults were loaded. Every corrupt
    /// file was moved to quarantine, so writing the defaults is safe.
    BothCorrupt,
    /// The main file could not be read, a corrupt file could not be quarantined,
    /// or the health mutex is poisoned. Persisting would overwrite or lose
    /// unrecoverable user data, so all writes are refused.
    UnsafeToWrite,
}

/// Readable snapshot of store health for IPC/UI. Constructed from the load
/// report and updated as writes succeed or fail.
#[derive(Debug, Clone, Serialize)]
pub struct StoreHealth {
    pub status: StoreStatus,
    pub main_path: String,
    pub backup_path: String,
    pub quarantine_path: Option<String>,
    /// False only when the load determined writing would destroy unrecoverable
    /// data (see [`StoreStatus::UnsafeToWrite`]).
    pub writable: bool,
    /// Whether the most recent write attempt succeeded. Starts true (no failed
    /// write observed yet).
    pub last_write_ok: bool,
    /// Human-readable detail; empty when healthy.
    pub message: String,
}

pub struct Store {
    pub data: Mutex<StoreData>,
    pub dir: PathBuf,
    health: Mutex<StoreHealth>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let (data, report) = load(&dir);
        let health = StoreHealth::from_report(&dir, &report);
        Store {
            data: Mutex::new(data),
            dir,
            health: Mutex::new(health),
        }
    }

    /// Current store health/recovery status for IPC/UI.
    #[allow(dead_code)]
    pub fn health(&self) -> StoreHealth {
        match self.health.lock() {
            Ok(h) => h.clone(),
            Err(_) => {
                // Fail closed: a poisoned health mutex means we cannot confirm
                // safety, so treat the store as not writable.
                StoreHealth {
                    status: StoreStatus::UnsafeToWrite,
                    main_path: self.dir.join(STORE_FILE).to_string_lossy().into_owned(),
                    backup_path: self.dir.join(BACKUP_FILE).to_string_lossy().into_owned(),
                    quarantine_path: None,
                    writable: false,
                    last_write_ok: false,
                    message: "store health mutex poisoned; writes disabled".into(),
                }
            }
        }
    }

    /// Persist the in-memory state. Refuses to write when the store is in an
    /// [`StoreStatus::UnsafeToWrite`] state so corrupt/unreadable user data is
    /// never silently overwritten. Signature kept compatible with existing
    /// callers; failures are recorded in health rather than returned.
    pub fn persist(&self) {
        if let Ok(data) = self.data.lock() {
            if !self.writable_locked() {
                return;
            }
            let result = write_store(&self.dir, &data);
            self.record_write_result(result);
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut StoreData) -> R) -> R {
        let mut data = self.data.lock().expect("store mutex poisoned");
        // Apply the closure to a clone and commit only on a successful write,
        // so a write failure or unsafe state never leaves in-memory state
        // ahead of disk. The closure's return value is still surfaced.
        let mut next = data.clone();
        let result = f(&mut next);
        if !self.writable_locked() {
            self.record_refusal();
            return result;
        }
        match write_store(&self.dir, &next) {
            Ok(()) => {
                *data = next;
                self.record_write_result(Ok(()));
            }
            Err(error) => {
                self.record_write_result(Err(error));
            }
        }
        result
    }

    pub fn transaction<R>(
        &self,
        f: impl FnOnce(&mut StoreData) -> Result<R, String>,
    ) -> Result<R, String> {
        let mut data = self.data.lock().map_err(|error| error.to_string())?;
        let mut next = data.clone();
        let result = f(&mut next)?;
        if !self.writable_locked() {
            self.record_refusal();
            return Err("store is not safely writable; refusing to persist".into());
        }
        match write_store(&self.dir, &next) {
            Ok(()) => {
                *data = next;
                self.record_write_result(Ok(()));
                Ok(result)
            }
            Err(error) => {
                let message = error.to_string();
                self.record_write_result(Err(error));
                Err(message)
            }
        }
    }

    /// Fail-closed: a poisoned health mutex means writes are refused.
    fn writable_locked(&self) -> bool {
        match self.health.lock() {
            Ok(h) => h.status != StoreStatus::UnsafeToWrite,
            Err(_) => false,
        }
    }

    fn record_refusal(&self) {
        if let Ok(mut h) = self.health.lock() {
            h.last_write_ok = false;
            if h.message.is_empty() {
                h.message = "write refused: store is not safely writable".into();
            }
        }
    }

    fn record_write_result(&self, result: std::io::Result<()>) {
        if let Ok(mut h) = self.health.lock() {
            match result {
                Ok(()) => {
                    h.last_write_ok = true;
                    match h.status {
                        StoreStatus::Fresh => {
                            // First successful write: a real main now exists.
                            h.status = StoreStatus::Ok;
                            h.message.clear();
                        }
                        StoreStatus::Ok => {
                            // Clear any prior failure message on a clean write.
                            h.message.clear();
                        }
                        // Preserve startup recovery statuses (and UnsafeToWrite)
                        // so the UI keeps surfacing the warning even after the
                        // recovery persist that AppState::new triggers.
                        _ => {}
                    }
                }
                Err(error) => {
                    h.last_write_ok = false;
                    h.message = format!("write failed: {}", error);
                }
            }
        }
    }
}

struct LoadReport {
    status: StoreStatus,
    quarantine: Option<PathBuf>,
    message: String,
}

impl LoadReport {
    fn ok() -> Self {
        Self {
            status: StoreStatus::Ok,
            quarantine: None,
            message: String::new(),
        }
    }

    fn new(status: StoreStatus, quarantine: Option<PathBuf>, message: String) -> Self {
        Self {
            status,
            quarantine,
            message,
        }
    }
}

impl StoreHealth {
    fn from_report(dir: &Path, report: &LoadReport) -> StoreHealth {
        let writable = report.status != StoreStatus::UnsafeToWrite;
        StoreHealth {
            status: report.status,
            main_path: dir.join(STORE_FILE).to_string_lossy().into_owned(),
            backup_path: dir.join(BACKUP_FILE).to_string_lossy().into_owned(),
            quarantine_path: report
                .quarantine
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            writable,
            last_write_ok: true,
            message: report.message.clone(),
        }
    }
}

enum BackupState {
    Absent,
    Valid(StoreData),
    Corrupt,
    Unreadable,
}

fn probe_backup(backup: &Path) -> BackupState {
    match std::fs::read_to_string(backup) {
        Ok(content) => match serde_json::from_str::<StoreData>(&content) {
            Ok(data) => BackupState::Valid(data),
            Err(_) => BackupState::Corrupt,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BackupState::Absent,
        // Permission or other read error: cannot confirm content, cannot safely
        // preserve via rename. Distinct from Absent.
        Err(_) => BackupState::Unreadable,
    }
}

fn load(dir: &Path) -> (StoreData, LoadReport) {
    let main = dir.join(STORE_FILE);
    let backup = dir.join(BACKUP_FILE);
    match std::fs::read_to_string(&main) {
        Ok(content) => match serde_json::from_str::<StoreData>(&content) {
            Ok(data) => (data, LoadReport::ok()),
            Err(_) => {
                // Main is corrupt. Quarantine the bad bytes so the original is
                // preserved for manual inspection before we overwrite it.
                match quarantine(&main) {
                    Ok(q_main) => match probe_backup(&backup) {
                        BackupState::Valid(data) => (
                            data,
                            LoadReport::new(
                                StoreStatus::RecoveredFromBackup,
                                Some(q_main.clone()),
                                format!(
                                    "main file corrupt; restored from backup (isolated {})",
                                    q_main.display()
                                ),
                            ),
                        ),
                        BackupState::Corrupt => match quarantine(&backup) {
                            Ok(q_bak) => (
                                StoreData::default(),
                                LoadReport::new(
                                    StoreStatus::BothCorrupt,
                                    Some(q_main.clone()),
                                    format!(
                                        "main and backup both corrupt; loaded defaults (isolated {} and {})",
                                        q_main.display(),
                                        q_bak.display()
                                    ),
                                ),
                            ),
                            Err(_) => (
                                StoreData::default(),
                                LoadReport::new(
                                    StoreStatus::UnsafeToWrite,
                                    Some(q_main),
                                    "main corrupt, backup corrupt and could not be isolated; writes disabled"
                                        .into(),
                                ),
                            ),
                        },
                        BackupState::Absent => (
                            StoreData::default(),
                            LoadReport::new(
                                StoreStatus::BothCorrupt,
                                Some(q_main.clone()),
                                format!(
                                    "main corrupt and no backup; loaded defaults (isolated {})",
                                    q_main.display()
                                ),
                            ),
                        ),
                        BackupState::Unreadable => (
                            StoreData::default(),
                            LoadReport::new(
                                StoreStatus::UnsafeToWrite,
                                Some(q_main),
                                "main corrupt, backup unreadable; writes disabled".into(),
                            ),
                        ),
                    },
                    Err(_) => {
                        // Could not move the corrupt main aside, so overwriting
                        // it would destroy unrecoverable data. Disable writes.
                        match probe_backup(&backup) {
                            BackupState::Valid(data) => (
                                data,
                                LoadReport::new(
                                    StoreStatus::UnsafeToWrite,
                                    None,
                                    "main corrupt and could not be isolated; writes disabled".into(),
                                ),
                            ),
                            _ => (
                                StoreData::default(),
                                LoadReport::new(
                                    StoreStatus::UnsafeToWrite,
                                    None,
                                    "main corrupt, could not isolate; writes disabled".into(),
                                ),
                            ),
                        }
                    }
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match probe_backup(&backup) {
                BackupState::Valid(data) => (
                    data,
                    LoadReport::new(
                        StoreStatus::RecoveredFromBackup,
                        None,
                        "main file missing; restored from backup".into(),
                    ),
                ),
                BackupState::Corrupt => match quarantine(&backup) {
                    Ok(q_bak) => (
                        StoreData::default(),
                        LoadReport::new(
                            StoreStatus::BothCorrupt,
                            Some(q_bak.clone()),
                            format!(
                                "main missing and backup corrupt; loaded defaults (isolated {})",
                                q_bak.display()
                            ),
                        ),
                    ),
                    Err(_) => (
                        StoreData::default(),
                        LoadReport::new(
                            StoreStatus::UnsafeToWrite,
                            None,
                            "main missing, backup corrupt and could not be isolated; writes disabled"
                                .into(),
                        ),
                    ),
                },
                BackupState::Absent => (
                    StoreData::default(),
                    LoadReport::new(StoreStatus::Fresh, None, "first run".into()),
                ),
                BackupState::Unreadable => (
                    StoreData::default(),
                    LoadReport::new(
                        StoreStatus::UnsafeToWrite,
                        None,
                        "main missing and backup unreadable; writes disabled".into(),
                    ),
                ),
            }
        }
        Err(error) => {
            // Permission or other read error on main; we cannot confirm it is
            // corrupt, so we must not overwrite it. Fall back to backup for
            // runtime use but refuse to persist.
            match probe_backup(&backup) {
                BackupState::Valid(data) => (
                    data,
                    LoadReport::new(
                        StoreStatus::UnsafeToWrite,
                        None,
                        format!("main unreadable ({}); writes disabled", error),
                    ),
                ),
                _ => (
                    StoreData::default(),
                    LoadReport::new(
                        StoreStatus::UnsafeToWrite,
                        None,
                        format!("main unreadable and no usable backup ({}); writes disabled", error),
                    ),
                ),
            }
        }
    }
}

/// Move a corrupt file aside so its bytes survive the next write. The
/// quarantine name is timestamped so repeated corruptions do not clobber each
/// other. On Windows `rename` replaces an existing target, so a stale
/// quarantine at the same nanosecond (extremely unlikely) is replaced.
fn quarantine(file: &Path) -> std::io::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let target = file.with_file_name(format!("{}.corrupt-{}", name, nanos));
    std::fs::rename(file, &target).map(|_| target)
}

/// Atomically persist `data` to the main file.
///
/// The previous main is preserved as the backup *only* after its current bytes
/// are read and validated, so an externally corrupted main can never clobber a
/// good backup. If the current main is valid it is written to the backup via a
/// temp + `fsync` + rename (atomic on Unix, replace-on-Windows), so a crash or
/// partial write never truncates the existing backup. If the current main is
/// corrupt it is quarantined instead of copied, and the backup is left
/// untouched. Any failure cleans up temp files and leaves both main and backup
/// at their pre-write state.
fn write_store(dir: &Path, data: &StoreData) -> std::io::Result<()> {
    let main = dir.join(STORE_FILE);
    let backup = dir.join(BACKUP_FILE);
    let tmp = dir.join(TMP_FILE);

    let json = serde_json::to_string_pretty(data)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;

    // 1. Stage the new main in a temp file and fsync for durability.
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(json.as_bytes())?;
        let _ = file.sync_all();
    }

    // 2. Decide what to do with the current main before promoting the temp.
    match std::fs::read_to_string(&main) {
        Ok(content) => {
            if serde_json::from_str::<StoreData>(&content).is_ok() {
                // Current main is valid: refresh the backup from its bytes
                // atomically. A failure here aborts the whole write so the good
                // backup is never clobbered.
                if let Err(error) = write_backup(&backup, &content) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(error);
                }
            } else {
                // Current main is corrupt (external tampering after open).
                // Isolate it; do NOT copy its bytes into the backup. If it
                // cannot be isolated, refuse to write rather than destroy the
                // only copy of the corrupt bytes without a backup.
                if let Err(error) = quarantine(&main) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(error);
                }
                // main is now absent; the good backup is left untouched.
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // No main to back up or isolate.
        }
        Err(error) => {
            // Cannot read main to validate it. Refuse to promote the temp: we
            // would overwrite an unreadable main (losing whatever is there) and
            // cannot decide whether to refresh the backup.
            let _ = std::fs::remove_file(&tmp);
            return Err(error);
        }
    }

    // 3. Atomically promote temp -> main (replaces existing on Unix and Windows).
    if let Err(error) = std::fs::rename(&tmp, &main) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }

    Ok(())
}

/// Write `content` to the backup file atomically: temp + fsync + rename. The
/// existing backup is left intact until the rename succeeds, so a crash or
/// partial write never truncates it.
fn write_backup(backup: &Path, content: &str) -> std::io::Result<()> {
    let tmp = backup.with_file_name(BACKUP_TMP_FILE);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        let _ = file.sync_all();
        std::fs::rename(&tmp, backup)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::StoreData;

    fn unique_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "calendar-store-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn write_raw(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, content).unwrap();
    }

    fn main_path(dir: &Path) -> PathBuf {
        dir.join(STORE_FILE)
    }
    fn backup_path(dir: &Path) -> PathBuf {
        dir.join(BACKUP_FILE)
    }

    fn corrupt_count(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter(|e| {
                        e.as_ref()
                            .map(|e| e.file_name().to_string_lossy().contains("corrupt"))
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn first_run_loads_defaults_and_is_fresh() {
        let dir = unique_dir("fresh");
        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(health.status, StoreStatus::Fresh);
        assert!(health.writable);
        assert!(health.last_write_ok);
        assert!(store.data.lock().unwrap().world_clocks.is_empty());

        // First successful write upgrades Fresh -> Ok.
        store.persist();
        assert!(main_path(&dir).is_file());
        assert_eq!(store.health().status, StoreStatus::Ok);
        cleanup(&dir);
    }

    #[test]
    fn normal_write_creates_backup_on_second_write() {
        let dir = unique_dir("backup");
        let store = Store::open(dir.clone());

        store
            .transaction(|d| {
                d.use_24_hour = false;
                Ok(())
            })
            .unwrap();
        assert!(main_path(&dir).is_file());
        assert!(!backup_path(&dir).exists());

        store
            .transaction(|d| {
                d.use_24_hour = true;
                Ok(())
            })
            .unwrap();
        assert!(backup_path(&dir).is_file());
        let backup: StoreData =
            serde_json::from_str(&std::fs::read_to_string(backup_path(&dir)).unwrap()).unwrap();
        assert!(!backup.use_24_hour);
        cleanup(&dir);
    }

    #[test]
    fn survives_reopen_round_trip() {
        let dir = unique_dir("roundtrip");
        let store = Store::open(dir.clone());
        store
            .transaction(|d| {
                d.world_clocks.push(crate::domain::WorldClockConfig {
                    label: "NYC".into(),
                    timezone: "America/New_York".into(),
                });
                d.use_24_hour = false;
                Ok(())
            })
            .unwrap();
        drop(store);

        let reopened = Store::open(dir.clone());
        assert_eq!(reopened.health().status, StoreStatus::Ok);
        let data = reopened.data.lock().unwrap();
        assert_eq!(data.world_clocks.len(), 1);
        assert!(!data.use_24_hour);
        drop(data);
        cleanup(&dir);
    }

    #[test]
    fn recovers_from_backup_when_main_corrupt() {
        let dir = unique_dir("recover");
        let store = Store::open(dir.clone());
        store
            .transaction(|d| {
                d.use_24_hour = false;
                Ok(())
            })
            .unwrap();
        store
            .transaction(|d| {
                d.use_24_hour = true;
                Ok(())
            })
            .unwrap();
        assert!(backup_path(&dir).is_file());

        write_raw(&main_path(&dir), "{ not valid json");
        let store2 = Store::open(dir.clone());
        let health = store2.health();
        assert_eq!(health.status, StoreStatus::RecoveredFromBackup);
        assert!(health.quarantine_path.is_some());
        assert!(!store2.data.lock().unwrap().use_24_hour);
        assert!(!main_path(&dir).exists());

        // The recovery persist that AppState::new triggers must NOT clear the
        // recovery status: the UI still needs to warn the user.
        store2.persist();
        assert_eq!(
            store2.health().status,
            StoreStatus::RecoveredFromBackup,
            "recovery status must survive the recovery persist"
        );
        assert!(store2.health().last_write_ok);
        assert!(main_path(&dir).is_file());

        drop(store2);
        let store3 = Store::open(dir.clone());
        assert_eq!(store3.health().status, StoreStatus::Ok);
        assert!(!store3.data.lock().unwrap().use_24_hour);
        cleanup(&dir);
    }

    #[test]
    fn both_corrupt_quarantines_main_and_backup_and_preserves_them() {
        let dir = unique_dir("bothbak");
        write_raw(&main_path(&dir), "main garbage");
        write_raw(&backup_path(&dir), "backup garbage");
        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(health.status, StoreStatus::BothCorrupt);
        assert!(health.quarantine_path.is_some());
        assert!(health.writable, "BothCorrupt is safe after isolation");
        // Both corrupt files were isolated.
        assert!(!main_path(&dir).exists());
        assert!(!backup_path(&dir).exists());
        assert_eq!(corrupt_count(&dir), 2);
        {
            let data = store.data.lock().unwrap();
            assert!(data.world_clocks.is_empty());
            assert!(data.use_24_hour);
        }

        // First persist writes defaults; isolated files untouched.
        store.persist();
        assert!(main_path(&dir).is_file());
        assert_eq!(corrupt_count(&dir), 2);

        // Second persist refreshes backup from the new valid main; the isolated
        // corrupt backup must NOT be overwritten by a normal save.
        store.persist();
        assert!(backup_path(&dir).is_file());
        assert_eq!(
            corrupt_count(&dir),
            2,
            "isolated corrupt backup must survive later saves"
        );
        assert_eq!(store.health().status, StoreStatus::BothCorrupt);
        cleanup(&dir);
    }

    #[test]
    fn missing_main_with_corrupt_backup_is_not_fresh() {
        let dir = unique_dir("misscorrupt");
        write_raw(&backup_path(&dir), "backup garbage");
        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(
            health.status,
            StoreStatus::BothCorrupt,
            "corrupt backup must not read as Fresh"
        );
        assert!(!backup_path(&dir).exists(), "corrupt backup must be isolated");
        assert!(health.quarantine_path.is_some());
        assert!(health.writable);
        cleanup(&dir);
    }

    #[test]
    fn transaction_write_failure_keeps_memory_unchanged() {
        let dir = unique_dir("txfail");
        let store = Store::open(dir.clone());

        std::fs::create_dir_all(main_path(&dir)).unwrap();

        let res = store.transaction(|d| {
            d.use_24_hour = false;
            Ok(())
        });
        assert!(res.is_err());
        assert!(store.data.lock().unwrap().use_24_hour);
        assert!(!main_path(&dir).is_file());
        assert!(!store.health().last_write_ok);
        cleanup(&dir);
    }

    #[test]
    fn with_does_not_commit_on_write_failure() {
        let dir = unique_dir("withfail");
        let store = Store::open(dir.clone());

        std::fs::create_dir_all(main_path(&dir)).unwrap();
        store.with(|d| {
            d.use_24_hour = false;
        });
        // Clone-and-commit-only-on-success: memory stays at default.
        assert!(store.data.lock().unwrap().use_24_hour);
        assert!(!main_path(&dir).is_file());
        assert!(!store.health().last_write_ok);
        cleanup(&dir);
    }

    #[test]
    fn with_commits_on_success() {
        let dir = unique_dir("withok");
        let store = Store::open(dir.clone());
        store.with(|d| {
            d.use_24_hour = false;
        });
        assert!(!store.data.lock().unwrap().use_24_hour);
        assert!(main_path(&dir).is_file());
        assert!(store.health().last_write_ok);
        cleanup(&dir);
    }

    #[test]
    fn external_main_corruption_does_not_clobber_backup() {
        let dir = unique_dir("extcorrupt");
        let store = Store::open(dir.clone());
        store
            .transaction(|d| {
                d.use_24_hour = false;
                Ok(())
            })
            .unwrap();
        store
            .transaction(|d| {
                d.use_24_hour = true;
                Ok(())
            })
            .unwrap();
        // in-memory = true, main = true, backup = false (last good).

        // Tamper with main after open.
        write_raw(&main_path(&dir), "garbage");

        // persist must quarantine the corrupt main and write in-memory back,
        // WITHOUT copying the garbage into the good backup.
        store.persist();

        let backup: StoreData =
            serde_json::from_str(&std::fs::read_to_string(backup_path(&dir)).unwrap()).unwrap();
        assert!(
            !backup.use_24_hour,
            "backup must not be clobbered with corrupt main bytes"
        );
        let main: StoreData =
            serde_json::from_str(&std::fs::read_to_string(main_path(&dir)).unwrap()).unwrap();
        assert!(main.use_24_hour);
        assert!(corrupt_count(&dir) >= 1, "corrupt main must be isolated");
        cleanup(&dir);
    }

    #[test]
    fn write_store_fails_on_missing_parent_dir() {
        let dir = std::env::temp_dir().join("calendar-store-nowhere-xyz-123");
        let _ = std::fs::remove_dir_all(&dir);
        let res = write_store(&dir, &StoreData::default());
        assert!(res.is_err());
    }

    #[test]
    fn poisoned_health_fails_closed() {
        let dir = unique_dir("poison");
        let store = Store::open(dir.clone());
        // Poison the health mutex by panicking while holding it.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = store.health.lock().unwrap();
            panic!("intentional poison");
        }));
        assert!(
            !store.writable_locked(),
            "poisoned health must fail closed (refuse writes)"
        );
        let h = store.health();
        assert_eq!(h.status, StoreStatus::UnsafeToWrite);
        assert!(!h.writable);
        assert!(!h.last_write_ok);
        assert!(h.message.contains("poisoned"));
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_when_cannot_quarantine_corrupt_main() {
        let dir = unique_dir("unsafe");
        write_raw(&main_path(&dir), "corrupt");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(health.status, StoreStatus::UnsafeToWrite);
        assert!(!health.writable);

        store.persist();
        assert_eq!(std::fs::read_to_string(main_path(&dir)).unwrap(), "corrupt");

        let res = store.transaction(|d| {
            d.use_24_hour = false;
            Ok(())
        });
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(main_path(&dir)).unwrap(), "corrupt");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn with_does_not_commit_memory_when_unsafe() {
        let dir = unique_dir("withunsafe");
        write_raw(&main_path(&dir), "corrupt");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let store = Store::open(dir.clone());
        assert_eq!(store.health().status, StoreStatus::UnsafeToWrite);
        store.with(|d| {
            d.use_24_hour = false;
        });
        // Unsafe: in-memory must not advance ahead of disk.
        assert!(store.data.lock().unwrap().use_24_hour);
        assert_eq!(std::fs::read_to_string(main_path(&dir)).unwrap(), "corrupt");
        assert!(!store.health().last_write_ok);

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn backup_preserved_when_write_fails() {
        let dir = unique_dir("bakprotect");
        let store = Store::open(dir.clone());
        store
            .transaction(|d| {
                d.use_24_hour = false;
                Ok(())
            })
            .unwrap();
        store
            .transaction(|d| {
                d.use_24_hour = true;
                Ok(())
            })
            .unwrap();
        // main = true, backup = false.

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let res = store.transaction(|d| {
            d.use_24_hour = false;
            Ok(())
        });
        assert!(res.is_err(), "write must fail on read-only dir");
        // In-memory unchanged (true).
        assert!(store.data.lock().unwrap().use_24_hour);
        // Backup untouched and still valid (false).
        let backup: StoreData =
            serde_json::from_str(&std::fs::read_to_string(backup_path(&dir)).unwrap()).unwrap();
        assert!(
            !backup.use_24_hour,
            "backup must not be touched on write failure"
        );

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_read_marks_unsafe_to_write() {
        let dir = unique_dir("unreadable");
        write_raw(
            &main_path(&dir),
            &serde_json::to_string(&StoreData::default()).unwrap(),
        );
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(main_path(&dir), std::fs::Permissions::from_mode(0o000)).unwrap();

        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(health.status, StoreStatus::UnsafeToWrite);
        assert!(!health.writable);
        assert!(health.message.contains("unreadable"));

        store.persist();
        assert!(main_path(&dir).is_file(), "unreadable main must not be overwritten");

        std::fs::set_permissions(main_path(&dir), std::fs::Permissions::from_mode(0o600)).unwrap();
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn missing_main_with_unreadable_backup_is_unsafe() {
        let dir = unique_dir("missunreadable");
        write_raw(&backup_path(&dir), "anything");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(backup_path(&dir), std::fs::Permissions::from_mode(0o000)).unwrap();

        let store = Store::open(dir.clone());
        let health = store.health();
        assert_eq!(
            health.status,
            StoreStatus::UnsafeToWrite,
            "unreadable backup must not read as Fresh"
        );
        assert!(!health.writable);
        // Unreadable backup is not isolated (cannot read/rename safely); left as-is.
        assert!(backup_path(&dir).exists());

        std::fs::set_permissions(backup_path(&dir), std::fs::Permissions::from_mode(0o600)).unwrap();
        cleanup(&dir);
    }
}
