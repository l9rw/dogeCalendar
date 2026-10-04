import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { translator } from "../data/i18n";
import { useSettingsStore } from "../stores/settingsStore";

type StorageHealth = {
  status: "fresh" | "ok" | "recovered_from_backup" | "both_corrupt" | "unsafe_to_write";
  main_path: string;
  backup_path: string;
  quarantine_path: string | null;
  writable: boolean;
  last_write_ok: boolean;
  message: string;
};

export function StorageNotice() {
  const language = useSettingsStore((state) => state.language);
  const { t } = translator(language);
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      void invoke<StorageHealth>("storage_health_get").then((value) => {
        if (active) { setHealth(value); setError(""); }
      }).catch((failure) => { if (active) setError(String(failure)); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (error) return <p className="date-format-error" role="alert">{t("storage.unavailable")}: {error}</p>;
  if (!health || ((health.status === "ok" || health.status === "fresh") && health.last_write_ok)) return null;
  const key = !health.writable ? "blocked" : !health.last_write_ok ? "writeFailed" : health.status;
  return (
    <aside className="storage-notice" role="alert">
      <strong>{t("storage.title")}</strong>
      <p>{t(`storage.${key}`)}</p>
      <p>{t("storage.guidance")}</p>
      <details>
        <summary>{t("storage.details")}</summary>
        <p>{t("storage.main")}: {health.main_path}</p>
        <p>{t("storage.backup")}: {health.backup_path}</p>
        {health.quarantine_path && <p>{t("storage.quarantine")}: {health.quarantine_path}</p>}
        {health.message && <p>{health.message}</p>}
      </details>
    </aside>
  );
}
