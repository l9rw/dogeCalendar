import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "../stores/settingsStore";
import { useInfoStore } from "../stores/infoStore";
import { translator, type Language } from "../data/i18n";
import {
  accentColors,
  lightBackgroundColors,
  darkBackgroundColors,
  colorName,
  type ColorInfo,
} from "../data/colors";
import { autostartApi, type UpdateStatus, type UpdateCheck } from "../services/ipc";

type MenuBarStyle = "calendar" | "date" | "weekday_date";
type View = "menu" | "appearance" | "calendar" | "language" | "menubar" | "taskbarDate" | "location" | "update";

const DATE_TEMPLATES = [
  ["yyyy/M/d", "简洁", "2026/9/28"],
  ["yyyy-MM-dd", "标准", "2026-09-28"],
  ["yyyy年M月d日", "中文", "2026年9月28日"],
  ["M月d日 dddd", "日期 + 星期", "9月28日 星期一"],
] as const;

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className="settings-toggle-row">
      <span className="toggle-label">{label}</span>
      <button
        type="button"
        className="settings-toggle"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
      />
    </div>
  );
}

function NavRow({
  label,
  value,
  onClick,
  children,
}: {
  label: string;
  value?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button className="settings-nav-row" onClick={onClick} type="button">
      <span className="nav-label">{label}</span>
      {value && <span className="nav-value">{value}</span>}
      {children}
      {onClick && <span className="nav-arrow" aria-hidden="true">›</span>}
    </button>
  );
}

function ColorSection({
  title,
  colors,
  selected,
  onSelect,
  inChinese,
}: {
  title: string;
  colors: ColorInfo[];
  selected: string;
  onSelect: (hex: string) => void;
  inChinese: boolean;
}) {
  return (
    <div className="settings-section">
      <span className="section-label">{title}</span>
      <div className="color-grid">
        {colors.map((color) => (
          <button
            key={color.hex}
            type="button"
            className={`color-swatch ${selected.toUpperCase() === color.hex.toUpperCase() ? "active" : ""}`}
            style={{ background: color.hex }}
            title={inChinese ? color.name_zh : color.name_en}
            onClick={() => onSelect(color.hex)}
            aria-label={inChinese ? color.name_zh : color.name_en}
          />
        ))}
      </div>
      <p className="color-grid-name">{colorName(selected, colors, inChinese)}</p>
    </div>
  );
}

export function SettingsPanel({
  onClose,
  onCheckUpdates,
  onIgnoreVersion,
  onInstallUpdate,
  appVersion,
  updateStatus,
  updateRelease,
  updateError,
  initialView,
}: {
  onClose: () => void;
  onCheckUpdates: () => void;
  onIgnoreVersion: () => void;
  onInstallUpdate: () => void;
  appVersion: string;
  updateStatus: UpdateStatus;
  updateRelease: UpdateCheck["release"];
  updateError: string;
  initialView?: "menu" | "update";
}) {
  const isMac = document.documentElement.dataset.platform === "macos";
  const store = useSettingsStore();
  const { t, inChinese } = useMemo(() => translator(store.language), [store.language]);
  const [view, setView] = useState<View>(initialView ?? "menu");
  const [appVer, setAppVer] = useState(appVersion);
  const [glassAvailable, setGlassAvailable] = useState(() => document.documentElement.dataset.nativeGlass === "true");

  useEffect(() => {
    if (isMac) void invoke<boolean>("macos_glass_enabled").then(setGlassAvailable).catch(console.error);
  }, [isMac]);

  useEffect(() => {
    if (!appVersion) void getVersion().then(setAppVer).catch(console.error);
  }, [appVersion]);

  const back = () => setView("menu");

  const themeOptions: { value: "light" | "dark" | "system"; label: string; desc: string }[] = [
    { value: "light", label: t("theme.light"), desc: t("theme.light.desc") },
    { value: "dark", label: t("theme.dark"), desc: t("theme.dark.desc") },
    { value: "system", label: t("theme.system"), desc: t("theme.system.desc") },
  ];

  const languageOptions: { value: Language; label: string }[] = [
    { value: "system", label: t("language.system") },
    { value: "zh_CN", label: t("language.zh_CN") },
    { value: "en_US", label: t("language.en_US") },
  ];

  const weekStartOptions: { value: 0 | 1 | 6; label: string }[] = [
    { value: 1, label: inChinese ? "周一" : "Mon" },
    { value: 0, label: inChinese ? "周日" : "Sun" },
    { value: 6, label: inChinese ? "周六" : "Sat" },
  ];

  const [launchBusy, setLaunchBusy] = useState(false);
  useEffect(() => {
    void autostartApi.get().then((enabled) => store.hydrateLaunchAtLogin(enabled)).catch(() => store.hydrateLaunchAtLogin(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleLaunch = async () => {
    setLaunchBusy(true);
    try {
      const next = await autostartApi.set(!store.launchAtLogin);
      store.hydrateLaunchAtLogin(next);
    } catch (error) {
      console.error("开机启动设置失败", error);
      store.hydrateLaunchAtLogin(await autostartApi.get().catch(() => false));
    } finally {
      setLaunchBusy(false);
    }
  };

  const titleKey = view === "menu" ? "settings.title"
    : view === "menubar" ? "settings.menubarStyle"
    : view === "location" ? "settings.locationWeather"
    : `settings.${view}`;

  const effectiveDark = store.theme === "dark" || (store.theme === "system" && matchSystemDark());

  return (
    <section className="settings-panel" aria-label={t("settings.title")}>
      <div className="settings-header">
        <div>
          <h2>{t(titleKey)}</h2>
        </div>
        <button className="settings-close" onClick={onClose} aria-label={t("settings.close")}>×</button>
      </div>

      {view === "menu" ? (
        <nav className="settings-nav">
          <NavRow label={t("settings.appearance")} value={t(`theme.${store.theme === "system" ? "system" : store.theme}`)} onClick={() => setView("appearance")} />
          <NavRow label={t("settings.calendar")} onClick={() => setView("calendar")} />
          <NavRow
            label={t("settings.language")}
            value={store.language === "system" ? t("language.system") : store.language === "zh_CN" ? t("language.zh_CN") : t("language.en_US")}
            onClick={() => setView("language")}
          />
          {isMac && <NavRow label={t("settings.menubarStyle")} onClick={() => setView("menubar")} />}
          {!isMac && <NavRow label={t("settings.taskbarDate")} onClick={() => setView("taskbarDate")} />}
          <NavRow label={t("settings.locationWeather")} onClick={() => setView("location")} />
          <div className="settings-nav-row">
            <span className="nav-label">{t("settings.launchAtLogin")}</span>
            <button
              type="button"
              className="settings-toggle"
              role="switch"
              aria-checked={store.launchAtLogin}
              aria-label={t("settings.launchAtLogin")}
              disabled={launchBusy}
              onClick={() => void toggleLaunch()}
            />
          </div>
        </nav>
      ) : view === "appearance" ? (
        <>
          <BackRow onBack={back} />
          <div className="settings-section">
            <span className="section-label">{t("appearance.theme")}</span>
            <div className="theme-options">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  className={`theme-option ${store.theme === option.value ? "active" : ""}`}
                  onClick={() => store.setTheme(option.value)}
                >
                  <span className={`theme-dot ${option.value}`} />
                  <span className="theme-label">{option.label}</span>
                  <span className="theme-desc">{option.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <ColorSection
            title={t("appearance.accentColor")}
            colors={accentColors}
            selected={effectiveDark ? store.appearance.darkAccent : store.appearance.lightAccent}
            onSelect={(hex) => store.setAccent(hex, effectiveDark)}
            inChinese={inChinese}
          />
          <ColorSection
            title={t("appearance.backgroundColor")}
            colors={effectiveDark ? darkBackgroundColors : lightBackgroundColors}
            selected={effectiveDark ? store.appearance.darkBackground : store.appearance.lightBackground}
            onSelect={(hex) => store.setBackground(hex, effectiveDark)}
            inChinese={inChinese}
          />
          {glassAvailable && (
            <div className="settings-section glass-opacity-setting">
              <label className="section-label" htmlFor="glass-opacity">{t("appearance.glassOpacity")}</label>
              <div className="glass-opacity-control">
                <input
                  id="glass-opacity"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={store.appearance.glassOpacity}
                  onChange={(event) => store.setGlassOpacity(Number(event.target.value))}
                />
                <output htmlFor="glass-opacity">{Math.round(store.appearance.glassOpacity)}%</output>
              </div>
              <p className="settings-description">{t("appearance.glassOpacity.desc")}</p>
            </div>
          )}
        </>
      ) : view === "calendar" ? (
        <>
          <BackRow onBack={back} />
          <div className="settings-section">
            <span className="section-label">{t("calendar.startWeekOn")}</span>
            <select
              className="settings-select"
              value={store.calendar.weekStart}
              onChange={(event) => store.setCalendarPref("weekStart", Number(event.target.value) as 0 | 1 | 6)}
            >
              {weekStartOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="settings-divider" />
          <Toggle label={t("calendar.showLunar")} checked={store.calendar.showLunar} onChange={(value) => store.setCalendarPref("showLunar", value)} />
          <Toggle label={t("calendar.showHolidays")} checked={store.calendar.showHolidays} onChange={(value) => store.setCalendarPref("showHolidays", value)} />
          <Toggle label={t("calendar.showWeekNumbers")} checked={store.calendar.showWeekNumbers} onChange={(value) => store.setCalendarPref("showWeekNumbers", value)} />
          <Toggle label={t("calendar.showEvents")} checked={store.calendar.showEvents} onChange={(value) => store.setCalendarPref("showEvents", value)} disabled />
          <Toggle label={t("calendar.keyboardShortcut")} checked={store.calendar.keyboardShortcut} onChange={(value) => store.setCalendarPref("keyboardShortcut", value)} />
        </>
      ) : view === "language" ? (
        <>
          <BackRow onBack={back} />
          <div className="theme-options">
            {languageOptions.map((option) => (
              <button
                key={option.value}
                className={`theme-option ${store.language === option.value ? "active" : ""}`}
                onClick={() => store.setLanguage(option.value)}
              >
                <span className="theme-label">{option.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : view === "menubar" ? (
        <MenuBarSettings onBack={back} t={t} />
      ) : view === "taskbarDate" ? (
        <TaskbarDateSettings onBack={back} t={t} />
      ) : view === "location" ? (
        <LocationSettings onBack={back} t={t} onClose={onClose} />
      ) : view === "update" ? (
        <>
          <BackRow onBack={back} />
          <p className="settings-description">{t("update.currentVersion")}：{appVer || "…"}</p>
          <Toggle label={t("update.auto")} checked={store.update.autoCheck} onChange={(value) => store.setUpdatePref("autoCheck", value)} />
          <Toggle label={t("update.beta")} checked={store.update.includeBeta} onChange={(value) => store.setUpdatePref("includeBeta", value)} />
          <div className="settings-divider" />
          <div className="update-message" role="status">
            {updateStatus === "checking" && t("update.checking")}
            {updateStatus === "current" && t("update.current")}
            {updateStatus === "unreleased" && t("update.unreleased")}
            {updateStatus === "available" && updateRelease && (<><strong>{t("update.available")} v{updateRelease.version}</strong><span>{t("update.available.desc")}</span></>)}
            {updateStatus === "installing" && t("update.installing")}
            {updateStatus === "error" && <>{t("update.failed")}：{updateError}</>}
            {updateStatus === "idle" && t("update.idle")}
          </div>
          <div className="info-actions" style={{ marginTop: 18 }}>
            {updateStatus === "installing" ? (
              <button className="info-button primary" disabled>{t("update.installing")}</button>
            ) : updateStatus === "available" && updateRelease ? (
              <>
                <button className="info-button primary" onClick={onInstallUpdate}>{t("update.goUpdate")}</button>
                <button className="info-button" onClick={onIgnoreVersion}>{t("update.ignore")}</button>
              </>
            ) : (
              <button className="info-button primary" disabled={updateStatus === "checking"} onClick={() => void onCheckUpdates()}>
                {updateStatus === "checking" ? t("update.checking") : t("update.recheck")}
              </button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return <button className="settings-back" onClick={onBack} style={{ marginBottom: 14 }}>‹ 返回</button>;
}

function matchSystemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function MenuBarSettings({ onBack, t }: { onBack: () => void; t: (key: string) => string }) {
  const isMac = document.documentElement.dataset.platform === "macos";
  const [style, setStyle] = useState<MenuBarStyle>("calendar");
  useEffect(() => {
    if (!isMac) return;
    void invoke<MenuBarStyle>("menu_bar_style_get").then(setStyle).catch(console.error);
  }, [isMac]);
  const options: { value: MenuBarStyle; label: string; desc: string }[] = [
    { value: "calendar", label: t("menubarStyle.calendar"), desc: t("menubarStyle.calendar.desc") },
    { value: "date", label: t("menubarStyle.date"), desc: t("menubarStyle.date.desc") },
    { value: "weekday_date", label: t("menubarStyle.weekdayDate"), desc: t("menubarStyle.weekdayDate.desc") },
  ];
  const change = async (next: MenuBarStyle) => {
    try {
      await invoke("menu_bar_style_set", { style: next });
      setStyle(next);
    } catch (error) {
      console.error("无法更新菜单栏图标", error);
    }
  };
  return (
    <>
      <BackRow onBack={onBack} />
      <div className="theme-options">
        {options.map((option) => (
          <button
            key={option.value}
            className={`theme-option ${style === option.value ? "active" : ""}`}
            aria-pressed={style === option.value}
            onClick={() => void change(option.value)}
          >
            <span className="theme-label">{option.label}</span>
            <span className="theme-desc">{option.desc}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function TaskbarDateSettings({ onBack, t }: { onBack: () => void; t: (key: string) => string }) {
  const [timeFormat, setTimeFormat] = useState("");
  const [currentTime, setCurrentTime] = useState("");
  const [timePreview, setTimePreview] = useState("");
  const [timeError, setTimeError] = useState("");
  const [timeSaving, setTimeSaving] = useState(false);
  useEffect(() => {
    void invoke<string>("taskbar_time_format_get")
      .then((format) => { setTimeFormat(format); setCurrentTime(format); })
      .catch((error) => setTimeError(String(error)));
  }, []);
  useEffect(() => {
    if (!timeFormat) { setTimePreview(""); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void invoke<string>("taskbar_time_format_preview", { format: timeFormat })
        .then((value) => { if (active) { setTimePreview(value); setTimeError(""); } })
        .catch((error) => { if (active) { setTimePreview(""); setTimeError(String(error)); } });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [timeFormat]);
  const applyTime = async () => {
    setTimeSaving(true);
    setTimeError("");
    try {
      const actual = await invoke<string>("taskbar_time_format_set", { format: timeFormat });
      setTimeFormat(actual);
      setCurrentTime(actual);
    } catch (error) {
      setTimeError(String(error));
    } finally {
      setTimeSaving(false);
    }
  };
  const [template, setTemplate] = useState("custom");
  const [custom, setCustom] = useState("");
  const [current, setCurrent] = useState("");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void invoke<string>("taskbar_date_format_get").then((format) => {
      setCurrent(format);
      setCustom(format);
      setTemplate(DATE_TEMPLATES.some(([value]) => value === format) ? format : "custom");
    }).catch((error) => setError(String(error)));
  }, []);

  const selectedFormat = template === "custom" ? custom : template;
  useEffect(() => {
    if (!selectedFormat) return;
    let active = true;
    setPreview("");
    const timer = window.setTimeout(() => {
      void invoke<string>("taskbar_date_format_preview", { format: selectedFormat })
        .then((value) => { if (active) { setPreview(value); setError(""); } })
        .catch((error) => { if (active) setError(String(error)); });
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedFormat]);

  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      const actual = await invoke<string>("taskbar_date_format_set", { format: selectedFormat });
      setCurrent(actual);
      if (template === "custom") setCustom(actual);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <BackRow onBack={onBack} />
      <p className="settings-description">{t("taskbarClock.description")}</p>
      <div className="settings-section">
        <label className="section-label" htmlFor="taskbar-time-format">{t("taskbarClock.timeFormat")}</label>
        <div className="date-format-options">
          {["HH:mm", "HH:mm:ss"].map((value) => (
            <button key={value} type="button" className={`theme-option ${timeFormat === value ? "active" : ""}`} onClick={() => setTimeFormat(value)}>
              <span className="theme-label">{value}</span>
            </button>
          ))}
        </div>
        <input id="taskbar-time-format" className="location-input date-format-input" value={timeFormat} maxLength={79}
          placeholder="HH:mm:ss" onChange={(event) => setTimeFormat(event.target.value)} />
        {timePreview && <p className="date-format-preview">{t("taskbarClock.preview")}：<strong>{timePreview}</strong></p>}
        {timeError && <p className="date-format-error" role="alert">{timeError}</p>}
        <button className="location-apply" disabled={timeSaving || !timeFormat || !!timeError || timeFormat === currentTime}
          onClick={() => void applyTime()}>{timeSaving ? t("settings.saving") : t("settings.applyToWindows")}</button>
      </div>
      <p className="settings-description">{t("taskbarClock.timeCodes")}</p>
      <div className="settings-divider" />
      <p className="settings-description">{t("taskbarClock.dateFormat")}</p>
      <div className="date-format-options">
        {DATE_TEMPLATES.map(([value, label, example]) => (
          <button key={value} className={`theme-option ${template === value ? "active" : ""}`} aria-pressed={template === value} onClick={() => setTemplate(value)}>
            <span className="theme-label">{label}</span><span className="theme-desc">{example}</span>
          </button>
        ))}
        <button className={`theme-option ${template === "custom" ? "active" : ""}`} aria-pressed={template === "custom"} onClick={() => setTemplate("custom")}>
          <span className="theme-label">自定义</span><span className="theme-desc">输入 Windows 日期格式</span>
        </button>
      </div>
      {template === "custom" && (
        <input className="location-input date-format-input" aria-label="自定义日期格式" placeholder="例如 yyyy/M/d dddd" value={custom} maxLength={79} onChange={(event) => setCustom(event.target.value)} />
      )}
      <p className="settings-description">{t("taskbarClock.dateCodes")}</p>
      {preview && <p className="date-format-preview">预览：<strong>{preview}</strong></p>}
      {error && <p className="date-format-error" role="alert">{error}</p>}
      <button className="location-apply" disabled={saving || !selectedFormat || selectedFormat === current} onClick={() => void apply()}>
        {saving ? t("settings.saving") : t("settings.applyToWindows")}
      </button>
    </>
  );
}

function LocationSettings({ onBack, t, onClose }: { onBack: () => void; t: (key: string) => string; onClose: () => void }) {
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [label, setLabel] = useState("");
  const setManualLocation = useInfoStore((state) => state.setManualLocation);
  const clearLocation = useInfoStore((state) => state.clearLocation);
  const clearWeatherCache = useInfoStore((state) => state.clearWeatherCache);

  return (
    <>
      <BackRow onBack={onBack} />
      <p className="settings-description">手动设置坐标会覆盖 IP 定位；清除后会重新使用 IP 兜底。</p>
      <div className="location-form">
        <input className="location-input" placeholder="纬度" value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" />
        <input className="location-input" placeholder="经度" value={lon} onChange={(event) => setLon(event.target.value)} inputMode="decimal" />
        <input className="location-input location-input-wide" placeholder="城市/地点名称" value={label} onChange={(event) => setLabel(event.target.value)} />
        <button
          className="location-apply"
          onClick={() => {
            const latitude = Number(lat);
            const longitude = Number(lon);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
            void setManualLocation(latitude, longitude, label || "自定义位置");
            setLat("");
            setLon("");
            setLabel("");
            onClose();
          }}
        >
          {t("settings.apply")}
        </button>
      </div>
      <div className="location-actions">
        <button className="location-action" onClick={() => void clearLocation()}>清除定位</button>
        <button className="location-action" onClick={() => void clearWeatherCache()}>清除天气缓存</button>
      </div>
    </>
  );
}
