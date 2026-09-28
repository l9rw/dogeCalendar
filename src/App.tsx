import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchHolidayYear, getCalendarMeta, dateKey, type HolidayYear } from "./services/calendarData";
import { fetchHuangli, type Huangli } from "./services/huangli";
import { useInfoStore } from "./stores/infoStore";
import {
  useSettingsStore,
  effectiveAppearance,
  resolveLanguage,
  type Theme,
} from "./stores/settingsStore";
import { translator } from "./data/i18n";
import type { WeatherReport, UpdateCheck, UpdateStatus } from "./services/ipc";
import { updateApi } from "./services/ipc";
import { WeatherCard } from "./components/WeatherCard";
import { WorldClockStrip } from "./components/WorldClockStrip";
import { SettingsPanel } from "./components/SettingsPanel";

type CalendarDay = {
  date: Date;
  lunarLabel: string;
  label?: string;
  holiday?: string;
  holidayType: "holiday" | "rest" | "workday" | "none";
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  isRest: boolean;
  isWorkday: boolean;
  weekNumber?: number;
};

type CalendarView = "month" | "year";
const IGNORED_UPDATE_KEY = "calendar-ignored-update";
const REPOSITORY_URL = "https://github.com/l9rw/dogeCalendar";

function useAppearanceEffect() {
  const theme = useSettingsStore((state) => state.theme);
  const appearance = useSettingsStore((state) => state.appearance);
  const language = useSettingsStore((state) => state.language);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onVisibility = () => { if (!document.hidden) setSystemDark(mql.matches); };
    const onFocus = () => setSystemDark(mql.matches);
    mql.addEventListener("change", handler);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      mql.removeEventListener("change", handler);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const { dark, accent, background } = effectiveAppearance(theme, systemDark, appearance);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--blue", accent);
    root.style.setProperty("--chip-soft", `color-mix(in srgb, ${accent} 14%, transparent)`);
    root.style.setProperty("--shell-border", `color-mix(in srgb, ${accent} 32%, var(--line))`);
    root.style.setProperty("--surface-3", `color-mix(in srgb, ${accent} 9%, var(--surface-2))`);
    root.style.setProperty("--shell-bg", background);
  }, [accent, background]);
  useEffect(() => {
    document.documentElement.dataset.lang = resolveLanguage(language);
  }, [language]);

  return { dark, systemDark };
}

function weekdayKeys() {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
}

function orderedWeekdays(weekStart: number) {
  const keys = weekdayKeys();
  return Array.from({ length: 7 }, (_, index) => (weekStart + index) % 7);
}

function startOfCalendarGrid(year: number, month: number, weekStart: number) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  return new Date(year, month, 1 - offset);
}

function isoWeekOfYear(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function buildMonth(
  year: number,
  month: number,
  holidayYears: Record<number, HolidayYear>,
  weekStart: number,
  showWeekNumbers: boolean,
): CalendarDay[] {
  const start = startOfCalendarGrid(year, month, weekStart);
  const today = new Date();
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const meta = getCalendarMeta(date, holidayYears);
    return {
      date,
      lunarLabel: meta.lunarDay === "初一" ? meta.lunar.slice(0, -meta.lunarDay.length) : meta.lunarDay || meta.lunar,
      label: meta.solarTerm,
      holiday: meta.holiday,
      isCurrentMonth: date.getMonth() === month,
      isToday: date.toDateString() === today.toDateString(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
      isRest: meta.holidayStatus === "rest" || meta.holidayStatus === "holiday",
      isWorkday: meta.holidayStatus === "workday",
      holidayType: meta.holidayType,
      weekNumber: showWeekNumbers && index % 7 === 0 ? isoWeekOfYear(date) : undefined,
    };
  });
}

function CurrentDateTime() {
  const language = useSettingsStore((state) => state.language);
  const { t } = useMemo(() => translator(language), [language]);
  const [current, setCurrent] = useState(() => new Date());

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      setCurrent(new Date());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) tick();
    };
    if (!document.hidden) timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const time = [current.getHours(), current.getMinutes(), current.getSeconds()]
    .map((part) => String(part).padStart(2, "0")).join(":");
  const weekdayKey = weekdayKeys()[current.getDay()];
  const weekday = t(`weekday.full.${weekdayKey}`);

  return (
    <section className="current-datetime" aria-label={t("today")}>
      <div className="current-date">
        <span>{t("today")} · {weekday}</span>
        <strong>{current.getFullYear()}年{current.getMonth() + 1}月{current.getDate()}日</strong>
      </div>
      <time className="current-time" dateTime={`${dateKey(current)}T${time}`}>{time}</time>
    </section>
  );
}

function parseDetailDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date();
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) || dateKey(date) !== value ? new Date() : date;
}

function DetailPanel() {
  const language = useSettingsStore((state) => state.language);
  const { t } = useMemo(() => translator(language), [language]);
  const [selected, setSelected] = useState(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    return parseDetailDate(date);
  });
  const [huangli, setHuangli] = useState<Huangli | null>(null);
  const [huangliDate, setHuangliDate] = useState<string | null>(null);
  const [huangliLoading, setHuangliLoading] = useState(false);
  const selectedKey = dateKey(selected);
  const selectedMeta = getCalendarMeta(selected);

  useEffect(() => {
    let disposed = false;
    const listener = listen<string>("detail-date-changed", (event) => {
      if (!disposed) setSelected(parseDetailDate(event.payload));
    });
    return () => { disposed = true; listener.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHuangliLoading(true);
    fetchHuangli(selectedKey)
      .then((data) => { if (!cancelled) { setHuangli(data); setHuangliDate(selectedKey); } })
      .catch(() => { if (!cancelled) { setHuangli(null); setHuangliDate(selectedKey); } })
      .finally(() => { if (!cancelled) setHuangliLoading(false); });
    return () => { cancelled = true; };
  }, [selectedKey]);

  const activeHuangli = huangliDate === selectedKey ? huangli : null;

  return (
    <main className="aux-shell detail-panel" aria-label={t("dateDetail")}>
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel: "detail" })} aria-label={t("settings.close")}>×</button>
      <div className="detail-topline">
        <img className="detail-mascot" src="/icon.png" alt="Doge" />
        <span className="detail-title">dogeCalendar</span>
        {selected.toDateString() === new Date().toDateString() && <span className="today-badge">{t("today")}</span>}
      </div>
      <div className="detail-date">
        <span className="detail-day">{selected.getDate()}</span>
        <div>
          <strong>{selected.getFullYear()}年{selected.getMonth() + 1}月</strong>
          <span>{t(`weekday.full.${weekdayKeys()[selected.getDay()]}`)}</span>
        </div>
      </div>
      <div className="detail-lunar"><span>{selectedMeta.lunar}</span><span>{t("lunar")}</span></div>
      <WeatherCard />
      <div className="detail-divider" />
      <div className="detail-almanac">
        <div className="detail-section"><span className="section-label">宜</span><p>{activeHuangli?.yi?.length ? activeHuangli.yi.join(" · ") : huangliLoading ? "加载中…" : "暂无宜事"}</p></div>
        <div className="detail-section detail-section-muted"><span className="section-label">忌</span><p>{activeHuangli?.ji?.length ? activeHuangli.ji.join(" · ") : huangliLoading ? "加载中…" : "暂无忌事"}</p></div>
      </div>
      <div className="huangli-meta">
        {activeHuangli?.ganzhi && <span><i>干支</i>{activeHuangli.ganzhi}</span>}
        {activeHuangli?.shengxiao && <span><i>生肖</i>{activeHuangli.shengxiao}</span>}
        {activeHuangli?.xingzuo && <span><i>星座</i>{activeHuangli.xingzuo}</span>}
        {activeHuangli?.jieqi && <span><i>节气</i>{activeHuangli.jieqi}</span>}
        {selectedMeta.holiday && <span><i>节日</i>{selectedMeta.holiday}</span>}
      </div>
      {(activeHuangli?.zhushen || activeHuangli?.taishen || activeHuangli?.pengsheng || (!activeHuangli && !huangliLoading)) && (
        <div className="side-holiday-card">
          {activeHuangli?.zhushen && <div className="holiday-lines"><p><i className="dark-icon">神</i>值神 · {activeHuangli.zhushen}</p></div>}
          {activeHuangli?.taishen && <div className="holiday-lines"><p><i className="dark-icon">胎</i>{activeHuangli.taishen}</p></div>}
          {activeHuangli?.pengsheng && <div className="holiday-lines"><p><i className="red-icon">忌</i>{activeHuangli.pengsheng}</p></div>}
          {!activeHuangli && !huangliLoading && <div className="holiday-lines"><p>黄历接口暂时不可用</p></div>}
        </div>
      )}
    </main>
  );
}

function AuxiliaryPanel({ panel }: { panel: "detail" | "clock" }) {
  const { t } = useTranslator();
  useAppearanceEffect();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") invoke("close_aux_panel", { panel });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
  useEffect(() => {
    if (panel !== "clock") return;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      if (timer === undefined && !document.hidden) {
        timer = window.setInterval(() => void useInfoStore.getState().loadClocks(), 15000);
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [panel]);
  if (panel === "detail") return <DetailPanel />;
  return (
    <main className="aux-shell clock-panel" aria-label={t("worldTime")}>
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel })} aria-label={t("settings.close")}>×</button>
      <WorldClockStrip />
    </main>
  );
}

export function App() {
  const panel = new URLSearchParams(window.location.search).get("panel");
  if (panel === "detail" || panel === "clock") return <AuxiliaryPanel panel={panel} />;
  return <CalendarApp />;
}

function CalendarApp() {
  const isMac = document.documentElement.dataset.platform === "macos";
  const now = new Date();
  const { t } = useTranslator();
  const theme = useSettingsStore((state) => state.theme);
  const calendar = useSettingsStore((state) => state.calendar);
  const updatePrefs = useSettingsStore((state) => state.update);
  const [cursor, setCursor] = useState(new Date(2026, 8, 1));
  const [selected, setSelected] = useState(now);
  const [view, setView] = useState<CalendarView>("month");
  const [contextMenu, setContextMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<"menu" | "update">("menu");
  const [infoPanel, setInfoPanel] = useState<"about" | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateRelease, setUpdateRelease] = useState<UpdateCheck["release"]>(null);
  const [updateError, setUpdateError] = useState("");
  const [showToolbarMenu, setShowToolbarMenu] = useState(false);
  const [holidayYears, setHolidayYears] = useState<Record<number, HolidayYear>>({});
  useAppearanceEffect();
  const days = useMemo(
    () => buildMonth(cursor.getFullYear(), cursor.getMonth(), holidayYears, calendar.weekStart, calendar.showWeekNumbers),
    [cursor, holidayYears, calendar.weekStart, calendar.showWeekNumbers],
  );

  useEffect(() => {
    let active = true;
    void fetchHolidayYear(cursor.getFullYear()).then((data) => {
      if (active && data) setHolidayYears((current) => ({ ...current, [cursor.getFullYear()]: data }));
    });
    return () => { active = false; };
  }, [cursor]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(console.error);
    let active = true;
    if (!updatePrefs.autoCheck) return;
    void updateApi.check(updatePrefs.includeBeta).then(async ({ release, currentVersion }) => {
      if (active) setAppVersion(currentVersion);
      if (!active || !release || localStorage.getItem(IGNORED_UPDATE_KEY) === release.version) return;
      setUpdateRelease(release);
      setUpdateStatus("available");
      setContextMenu(false);
      setInfoPanel(null);
      setShowSettings(true);
      setSettingsView("update");
      await invoke("show_update_panel");
    }).catch((error) => console.error("启动时检查更新失败", error));
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkUpdates = async () => {
    setContextMenu(false);
    setShowToolbarMenu(false);
    setInfoPanel(null);
    setShowSettings(true);
    setSettingsView("update");
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const result = await updateApi.check(updatePrefs.includeBeta);
      setAppVersion(result.currentVersion);
      setUpdateRelease(result.release);
      setUpdateStatus(result.release ? "available" : result.hasRelease ? "current" : "unreleased");
    } catch (error) {
      setUpdateStatus("error");
      setUpdateError(String(error));
    }
  };

  const ignoreUpdate = () => {
    if (updateRelease) localStorage.setItem(IGNORED_UPDATE_KEY, updateRelease.version);
    setShowSettings(false);
  };

  const openSettings = () => {
    setContextMenu(false);
    setInfoPanel(null);
    setShowSettings(true);
    setSettingsView("menu");
  };

  const showAbout = () => {
    setContextMenu(false);
    setShowSettings(false);
    setShowToolbarMenu(false);
    setInfoPanel("about");
  };

  const moveMonth = (offset: number) => {
    setCursor((value) => new Date(value.getFullYear(), value.getMonth() + offset, 1));
  };

  const moveYear = (offset: number) => {
    setCursor((value) => new Date(value.getFullYear() + offset, value.getMonth(), 1));
  };

  const selectDate = (date: Date) => {
    setSelected(date);
    setCursor(new Date(date.getFullYear(), date.getMonth(), 1));
    void invoke("open_aux_panel", { panel: "detail", date: dateKey(date) });
  };

  useEffect(() => {
    if (!calendar.keyboardShortcut) return;
    const onKey = (event: KeyboardEvent) => {
      if (showSettings || contextMenu || infoPanel) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      switch (event.key) {
        case "ArrowLeft": event.preventDefault(); moveMonth(-1); break;
        case "ArrowRight": event.preventDefault(); moveMonth(1); break;
        case "ArrowUp": event.preventDefault(); moveYear(-1); break;
        case "ArrowDown": event.preventDefault(); moveYear(1); break;
        case " ": event.preventDefault(); selectDate(new Date()); break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar.keyboardShortcut, showSettings, contextMenu, infoPanel]);

  const handleCalendarWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) >= 8) moveMonth(event.deltaY < 0 ? -1 : 1);
  };

  const selectedKey = selected.toDateString();

  useEffect(() => {
    const listeners = [
      listen("taskbar-calendar-click", () => {
      setContextMenu(false);
      setShowSettings(false);
      setInfoPanel(null);
      }),
      listen("taskbar-calendar-context", () => {
      setContextMenu(true);
      setShowSettings(false);
      setInfoPanel(null);
      }),
      listen("open-settings", () => {
      openSettings();
      }),
    ];
    return () => {
      void Promise.allSettled(listeners).then((results) => {
        results.forEach((result) => {
          if (result.status === "fulfilled") result.value();
        });
      });
    };
  }, []);

  useEffect(() => {
    const loadClocks = useInfoStore.getState().loadClocks;
    let timer: number | undefined;
    const tick = () => loadClocks();
    const start = () => {
      if (timer === undefined) {
        tick();
        timer = window.setInterval(tick, 15000);
      }
    };
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const dispose = listen<unknown>("weather-refreshed", (event) => {
      if (disposed) return;
      useInfoStore.getState().applyWeather(event.payload as WeatherReport);
    });
    return () => {
      disposed = true;
      dispose.then((fn) => fn());
    };
  }, []);

  const weekdayOrder = orderedWeekdays(calendar.weekStart);
  const showLunar = calendar.showLunar;
  const showHolidays = calendar.showHolidays;

  return (
    <main className="calendar-shell">
      {contextMenu ? (
        <div className="taskbar-context-menu" role="menu">
          <button role="menuitem" onClick={() => setContextMenu(false)}>{t("menu.openCalendar")}</button>
          <button role="menuitem" onClick={openSettings}>{t("menu.settings")}</button>
          {isMac && <button role="menuitem" onClick={openSettings}>{t("menu.menubarSettings")}</button>}
          <button role="menuitem" onClick={() => void checkUpdates()}>{t("menu.onlineUpdate")}</button>
          <button role="menuitem" onClick={showAbout}>{t("menu.about")}</button>
          <button role="menuitem" onClick={() => invoke("quit_app")}>{t("menu.quit")}</button>
        </div>
      ) : infoPanel ? (
        <section className="settings-panel info-panel" aria-label={t("settings.about")}>
          <div className="settings-header">
            <div><p className="eyebrow">ABOUT dogeCalendar</p><h2>{t("settings.about")}</h2></div>
            <button className="settings-close" aria-label={t("settings.close")} onClick={() => setInfoPanel(null)}>×</button>
          </div>
          <div className="info-app"><img src="/icon.png" alt="" /><div><strong>dogeCalendar</strong><span>{t("update.currentVersion")} {appVersion || "…"}</span></div></div>
          <p className="settings-description">{t("about.tagline")}</p>
          <div className="info-actions">
            <button className="info-button primary" onClick={() => void checkUpdates()}>{t("update.checkNow")}</button>
            <button className="info-button" onClick={() => void openUrl(REPOSITORY_URL)}>{t("about.repo")}</button>
          </div>
        </section>
      ) : showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onCheckUpdates={() => void checkUpdates()}
          onIgnoreVersion={ignoreUpdate}
          appVersion={appVersion}
          updateStatus={updateStatus}
          updateRelease={updateRelease}
          updateError={updateError}
          initialView={settingsView}
        />
      ) : <><CurrentDateTime /><div className="calendar-layout">
        <section className="calendar-area" aria-label={t("settings.calendar")}>
        <header className="calendar-header">
          <div className="month-control">
            <button aria-label={t("calendar.startWeekOn")} onClick={() => moveMonth(-1)}>‹</button>
            <select
              className="calendar-select"
              aria-label={t("settings.calendar")}
              value={cursor.getMonth()}
              onChange={(event) => setCursor(new Date(cursor.getFullYear(), Number(event.target.value), 1))}
            >
              {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{month + 1}月</option>)}
            </select>
            <button aria-label={t("settings.calendar")} onClick={() => moveMonth(1)}>›</button>
          </div>
          <select
            className="calendar-select calendar-select-year"
            aria-label={t("settings.calendar")}
            value={cursor.getFullYear()}
            onChange={(event) => setCursor(new Date(Number(event.target.value), cursor.getMonth(), 1))}
          >
            {Array.from({ length: 201 }, (_, offset) => {
              const year = 1900 + offset;
              return <option key={year} value={year}>{year}年</option>;
            })}
          </select>
          <div className="calendar-toolbar">
            <button
              className="toolbar-icon"
              aria-label={t("today")}
              title={t("today")}
              onClick={() => selectDate(new Date())}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" fill="currentColor" />
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="toolbar-icon toolbar-menu-toggle"
              aria-label={t("menu.about")}
              title={t("menu.about")}
              aria-pressed={showToolbarMenu}
              onClick={() => setShowToolbarMenu((value) => !value)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <circle cx="5" cy="12" r="1.7" fill="currentColor" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
                <circle cx="19" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </button>
            {showToolbarMenu && (
              <>
                <button
                  className="toolbar-menu-overlay"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setShowToolbarMenu(false)}
                />
                <div className="toolbar-menu" role="menu">
                  <button
                    role="menuitem"
                    className="toolbar-menu-item"
                    onClick={() => { void invoke("open_aux_panel", { panel: "clock" }); setShowToolbarMenu(false); }}
                  >
                    <span className="toolbar-menu-check" />
                    <span>{t("menu.worldClock")}</span>
                  </button>
                  {isMac && <button
                    role="menuitem"
                    className="toolbar-menu-item"
                    onClick={() => { openSettings(); setShowToolbarMenu(false); }}
                  >
                    <span className="toolbar-menu-check" />
                    <span>{t("menu.menubarSettings")}</span>
                  </button>}
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => { openSettings(); setShowToolbarMenu(false); }}>
                    <span className="toolbar-menu-check" /><span>{t("menu.settings")}</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => void checkUpdates()}>
                    <span className="toolbar-menu-check" /><span>{t("menu.onlineUpdate")}</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={showAbout}>
                    <span className="toolbar-menu-check" /><span>{t("menu.about")}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <div className="calendar-body">
        {view === "month" ? (
          <div className="calendar-card" onWheel={handleCalendarWheel}>
            <div className="weekday-row">
              {weekdayOrder.map((dayIndex) => (
                <span className={dayIndex === 0 || dayIndex === 6 ? "weekend-heading" : ""} key={dayIndex}>
                  {t(`weekday.${weekdayKeys()[dayIndex]}`)}
                </span>
              ))}
            </div>
            <div className="month-grid">
              {days.map((day) => {
                const selectedDay = selectedKey === day.date.toDateString();
                return (
                  <button
                    className={`day-cell ${day.isCurrentMonth ? "" : "muted"} ${day.isWeekend ? "weekend" : ""} ${selectedDay ? "selected" : ""} ${day.isToday ? "today" : ""} ${showHolidays && day.isRest ? "holiday-cell" : ""} ${showHolidays && day.isWorkday ? "workday-cell" : ""}`}
                    key={day.date.toISOString()}
                    onClick={() => selectDate(day.date)}
                    aria-current={day.isToday ? "date" : undefined}
                  >
                    {day.weekNumber !== undefined && <b className="week-mark">{t("week")}{day.weekNumber}</b>}
                    <span className="solar-day">{day.date.getDate()}{showHolidays && day.isWorkday && <b className="work-mark">班</b>}</span>
                    <span className={`lunar-day ${showHolidays && (day.holiday || day.label) ? "special-day" : ""}`}>
                      {showLunar ? (showHolidays ? (day.holiday ?? day.label ?? day.lunarLabel) : (day.label ?? day.lunarLabel)) : ""}
                    </span>
                    {showHolidays && day.isRest && <b className="rest-mark">休</b>}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="year-grid" aria-label={`${cursor.getFullYear()}年全年视图`}>
             {Array.from({ length: 12 }, (_, month) => (
              <section className="mini-month" key={month}>
                <button className="mini-month-title" onClick={() => { setCursor(new Date(cursor.getFullYear(), month, 1)); setView("month"); }}>{month + 1}月</button>
                <div className="mini-weekdays">{weekdayOrder.map((dayIndex) => <span key={dayIndex}>{t(`weekday.${weekdayKeys()[dayIndex]}`)}</span>)}</div>
                 <div className="mini-month-grid">{buildMonth(cursor.getFullYear(), month, holidayYears, calendar.weekStart, false).map((day) => <button key={day.date.toISOString()} className={`${day.isCurrentMonth ? "" : "muted"} ${day.isToday ? "today" : ""}`} onClick={() => selectDate(day.date)}>{day.date.getDate()}</button>)}</div>
              </section>
            ))}
          </div>
        )}
        </div>
        </section>
      </div>
      </>}
    </main>
  );
}

function useTranslator() {
  const language = useSettingsStore((state) => state.language);
  return useMemo(() => translator(language), [language]);
}

// Theme re-export for legacy references; keeps the module self-contained.
export type { Theme };
