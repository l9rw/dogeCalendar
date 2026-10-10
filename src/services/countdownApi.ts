import { invoke } from "@tauri-apps/api/core";

export type CountdownEvent = {
  id: string;
  title: string;
  target_at: number;
  language: "zh" | "en";
  reminded_at: number | null;
  delivery_results: { channel: string; status: string }[];
};

export type NotificationConfig = {
  bark_enabled: boolean;
  bark_server: string;
  bark_configured: boolean;
  serverchan_enabled: boolean;
  serverchan_configured: boolean;
};

export type NotificationChannel = "system" | "bark" | "serverchan";

export const countdownApi = {
  list: () => invoke<CountdownEvent[]>("countdown_list"),
  save: (id: string | null, title: string, targetAt: number, language: "zh" | "en") =>
    invoke<void>("countdown_save", { id, title, targetAt, language }),
  delete: (id: string) => invoke<void>("countdown_delete", { id }),
  config: () => invoke<NotificationConfig>("notification_config_get"),
  saveConfig: (config: NotificationConfig, barkKey: string | null, serverchanKey: string | null) =>
    invoke<void>("notification_config_save", {
      config: { bark_enabled: config.bark_enabled, bark_server: config.bark_server, serverchan_enabled: config.serverchan_enabled },
      barkKey, serverchanKey,
    }),
  test: (channel: NotificationChannel, language: "zh" | "en") =>
    invoke<void>("notification_test", { channel, language }),
};
