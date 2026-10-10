import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { translator } from "../data/i18n";
import { syncRuntimePreferences, useSettingsStore } from "../stores/settingsStore";
import { countdownApi, type CountdownEvent, type NotificationChannel, type NotificationConfig } from "../services/countdownApi";
import { countdownTarget, localDateTimeValue, remainingTime, validBarkServer } from "../services/countdown";
import { startVisibleClock } from "../services/visibleClock";

export function CountdownSettings() {
  const language = useSettingsStore((state) => state.language);
  const network = useSettingsStore((state) => state.modules.network);
  const { t, inChinese } = translator(language);
  const [events, setEvents] = useState<CountdownEvent[]>([]);
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState(() => localDateTimeValue(new Date(Date.now() + 5 * 60_000)));
  const [barkKey, setBarkKey] = useState<string | null>(null);
  const [serverchanKey, setServerchanKey] = useState<string | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [permission, setPermission] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const refreshVersion = useRef(0);
  const actionRunning = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const native = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!native) { setLoading(false); return; }
    let active = true;
    const refresh = async () => {
      const version = ++refreshVersion.current;
      try {
        const values = await countdownApi.list();
        if (active && version === refreshVersion.current) setEvents(values);
      } catch (failure) { if (active) setError(String(failure)); }
    };
    const focus = () => {
      void refresh();
      void clock.refresh();
      void isPermissionGranted().then((value) => { if (active) setPermission(value); }).catch(() => {});
    };
    const unlisten = listen("countdowns-changed", () => { void refresh(); });
    void unlisten.then(() => { if (active) void refresh(); }).catch((failure) => { if (active) setError(String(failure)); });
    void countdownApi.config().then((value) => { if (active) setConfig(value); })
      .catch((failure) => { if (active) setError(String(failure)); })
      .finally(() => { if (active) setLoading(false); });
    const nativeWindow = getCurrentWindow();
    const clock = startVisibleClock({
      isVisible: () => nativeWindow.isVisible(),
      update: (date) => setNow(date.getTime() / 1000),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
      onError: (failure) => { if (active) setError(String(failure)); },
    });
    const unlistenFocus = nativeWindow.onFocusChanged(focus);
    void unlistenFocus.catch((failure) => { if (active) setError(String(failure)); });
    focus();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      active = false;
      clock.dispose();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      void unlistenFocus.then((stop) => stop()).catch(() => {});
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [native]);

  const run = async (action: () => Promise<void>) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      const status = t(`countdown.status.${detail}`);
      setError(status === `countdown.status.${detail}` ? detail : status);
    }
    finally { actionRunning.current = false; setBusy(false); }
  };

  const refreshAfterAction = async () => {
    const version = ++refreshVersion.current;
    const values = await countdownApi.list();
    if (version === refreshVersion.current) setEvents(values);
  };

  const allowNotifications = async () => {
    const allowed = await isPermissionGranted() || await requestPermission() === "granted";
    setPermission(allowed);
    return allowed;
  };

  const testChannel = (channel: NotificationChannel) => run(async () => {
    if (channel === "system" && !await allowNotifications()) throw new Error(t("countdown.permissionDenied"));
    await syncRuntimePreferences();
    await countdownApi.test(channel, inChinese ? "zh" : "en");
    setMessage(t("countdown.testSent"));
  });

  const reset = () => {
    setId(null); setTitle("");
    setTarget(localDateTimeValue(new Date(Date.now() + 5 * 60_000)));
  };

  return <div className="countdown-settings">
    <p className="settings-description">{t("countdown.description")}</p>
    {!native && <p className="date-format-error" role="alert">{t("countdown.nativeOnly")}</p>}
    {loading && <p className="settings-description">{t("countdown.loading")}</p>}
    {error && <p className="date-format-error" role="alert">{error}</p>}
    {message && <p className="settings-description" role="status">{message}</p>}
    {permission === false && <p className="date-format-error" role="status">{t("countdown.permissionDenied")}</p>}
    <form className="countdown-form" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const targetAt = countdownTarget(target);
        if (!title.trim() || Array.from(title.trim()).length > 100 || targetAt === null) throw new Error(t("countdown.invalid"));
        // Permission is requested only from an explicit user action, never at startup.
        await allowNotifications();
        await syncRuntimePreferences();
        await countdownApi.save(id, title.trim(), targetAt, inChinese ? "zh" : "en");
        reset();
        await refreshAfterAction();
        setMessage(t("countdown.saved"));
      });
    }}>
      <label htmlFor="countdown-title">{t("countdown.eventTitle")}</label>
      <input ref={titleInput} id="countdown-title" className="location-input" value={title} maxLength={100} required disabled={!native || busy}
        onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor="countdown-target">{t("countdown.target")}</label>
      <input id="countdown-target" className="location-input" type="datetime-local" value={target} required disabled={!native || busy}
        onChange={(event) => setTarget(event.target.value)} />
      <p className="settings-description">{t("countdown.timeHint")}</p>
      <div className="countdown-actions">
        <button className="info-button primary" disabled={!native || busy || loading}>{t(id ? "countdown.save" : "countdown.add")}</button>
        {id && <button type="button" className="info-button" disabled={busy} onClick={reset}>{t("countdown.cancel")}</button>}
      </div>
    </form>

    <section className="countdown-list" aria-label={t("countdown.events")}>
      <h3>{t("countdown.events")}</h3>
      {!loading && !events.length && <p className="settings-description">{t("countdown.empty")}</p>}
      {[...events].sort((a, b) => a.target_at - b.target_at).map((event) => <article className="countdown-event" key={event.id}>
        <strong>{event.title}</strong>
        <time dateTime={new Date(event.target_at * 1000).toISOString()}>{new Date(event.target_at * 1000).toLocaleString(inChinese ? "zh-CN" : "en-US")}</time>
        <span className="countdown-remaining">{event.target_at <= now ? t("countdown.expired") : remainingTime(event.target_at, now)}</span>
        {event.reminded_at !== null && !event.delivery_results.length && <span>{t("countdown.dispatched")}</span>}
        {event.delivery_results.map((result) => <span className="countdown-delivery" key={result.channel}>
          {t(`countdown.${result.channel}`)}: {t(`countdown.status.${result.status}`) === `countdown.status.${result.status}` ? result.status : t(`countdown.status.${result.status}`)}
        </span>)}
        <div className="countdown-actions">
          <button className="info-button" disabled={busy} onClick={() => {
            setId(event.id); setTitle(event.title); setTarget(localDateTimeValue(new Date(event.target_at * 1000)));
            titleInput.current?.focus();
          }}>{t("countdown.edit")}</button>
          <button className="info-button" disabled={busy} onClick={() => void run(async () => {
            await countdownApi.delete(event.id);
            if (id === event.id) reset();
            await refreshAfterAction();
          })}>{t("countdown.delete")}</button>
        </div>
      </article>)}
    </section>

    <details className="countdown-channels">
      <summary>{t("countdown.channels")}</summary>
      <p className="settings-description">{t("countdown.privacy")}</p>
      <button className="info-button" disabled={!native || busy} onClick={() => void testChannel("system")}>{t("countdown.testSystem")}</button>
      {!network && <p className="date-format-error">{t("countdown.networkDisabled")}</p>}
      {config && <form className="countdown-form" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!validBarkServer(config.bark_server)) throw new Error(t("countdown.invalidBarkServer"));
          await countdownApi.saveConfig(config, barkKey, serverchanKey);
          setConfig(await countdownApi.config());
          setBarkKey(null); setServerchanKey(null); setConfigDirty(false);
          setMessage(t("countdown.configSaved"));
        });
      }}>
        <fieldset disabled={busy}>
          <legend>Bark</legend>
          <label className="countdown-check"><input type="checkbox" checked={config.bark_enabled} onChange={(event) => {
            setConfig({ ...config, bark_enabled: event.target.checked }); setConfigDirty(true);
          }} />{t("countdown.enable")}</label>
          <label htmlFor="bark-server">{t("countdown.barkServer")}</label>
          <input id="bark-server" className="location-input" type="url" required value={config.bark_server} onChange={(event) => {
            setConfig({ ...config, bark_server: event.target.value }); setConfigDirty(true);
          }} />
          <label htmlFor="bark-key">Device Key {config.bark_configured && t("countdown.configured")}</label>
          <input id="bark-key" className="location-input" type="password" maxLength={512} autoComplete="new-password" spellCheck={false} value={barkKey ?? ""}
            placeholder={t(barkKey === "" ? "countdown.keyCleared" : "countdown.keyHint")} onChange={(event) => { setBarkKey(event.target.value || null); setConfigDirty(true); }} />
          <div className="countdown-actions">
            <button type="button" className="info-button" onClick={() => { setBarkKey(""); setConfig({ ...config, bark_enabled: false }); setConfigDirty(true); }}>{t("countdown.clearKey")}</button>
            <button type="button" className="info-button" disabled={!network || configDirty || !config.bark_configured || !config.bark_enabled} onClick={() => void testChannel("bark")}>{t("countdown.test")}</button>
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>{t("countdown.serverchan")}</legend>
          <label className="countdown-check"><input type="checkbox" checked={config.serverchan_enabled} onChange={(event) => {
            setConfig({ ...config, serverchan_enabled: event.target.checked }); setConfigDirty(true);
          }} />{t("countdown.enable")}</label>
          <label htmlFor="serverchan-key">SendKey {config.serverchan_configured && t("countdown.configured")}</label>
          <input id="serverchan-key" className="location-input" type="password" maxLength={512} autoComplete="new-password" spellCheck={false} value={serverchanKey ?? ""}
            placeholder={t(serverchanKey === "" ? "countdown.keyCleared" : "countdown.keyHint")} onChange={(event) => { setServerchanKey(event.target.value || null); setConfigDirty(true); }} />
          <p className="settings-description">{t("countdown.serverchanHint")}</p>
          <div className="countdown-actions">
            <button type="button" className="info-button" onClick={() => { setServerchanKey(""); setConfig({ ...config, serverchan_enabled: false }); setConfigDirty(true); }}>{t("countdown.clearKey")}</button>
            <button type="button" className="info-button" disabled={!network || configDirty || !config.serverchan_configured || !config.serverchan_enabled} onClick={() => void testChannel("serverchan")}>{t("countdown.test")}</button>
          </div>
        </fieldset>
        <button className="info-button primary" disabled={busy || !configDirty}>{t("countdown.saveChannels")}</button>
        <p className="settings-description">{t("countdown.testHint")}</p>
      </form>}
    </details>
  </div>;
}
