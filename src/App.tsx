import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startVisibleClock } from "./services/visibleClock";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchHolidayYear, getCalendarMeta, dateKey, getCachedHolidayYears, cancelHolidayRequests, getHolidayCountdown, type HolidayYear } from "./services/calendarData";
import type { Huangli } from "./services/huangli";
import { useInfoStore } from "./stores/infoStore";
import {
  useSettingsStore,
  syncRuntimePreferences,
  effectiveAppearance,
  resolveLanguage,
  type Theme,
} from "./stores/settingsStore";
import { translator } from "./data/i18n";
import type { UpdateCheck, UpdateStatus } from "./services/ipc";
import { updateApi } from "./services/ipc";
import { WeatherCard } from "./components/WeatherCard";
import { WorldClockStrip } from "./components/WorldClockStrip";
import { SettingsPanel } from "./components/SettingsPanel";
import { StorageNotice } from "./components/StorageNotice";
import { parseCivilDate, daysRemainingInYear } from "./services/dateTools";

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
const FEEDBACK_URL = `mailto:i@l9rw.cn?subject=${encodeURIComponent("dogeCalendar 意见反馈")}`;

function useVisibleToday() {
  const [today, setToday] = useState(() => dateKey(new Date()));
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const now = new Date();
      setToday(dateKey(now));
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(refresh, midnight.getTime() - now.getTime() + 50);
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return today;
}

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
    root.style.setProperty("--glass-opacity", `${appearance.glassOpacity}%`);
  }, [accent, background, appearance.glassOpacity]);
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
  const { t, inChinese } = useMemo(() => translator(language), [language]);
  const [current, setCurrent] = useState(() => new Date());

  useEffect(() => {
    const nativeWindow = "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;
    const clock = startVisibleClock({
      // AppKit can show the panel without updating WKWebView document.hidden.
      isVisible: () => nativeWindow ? nativeWindow.isVisible() : !document.hidden,
      update: setCurrent,
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
      onError: console.error,
    });
    const refresh = () => { void clock.refresh(); };
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (nativeWindow) {
      void nativeWindow.onFocusChanged(refresh).then((dispose) => {
        if (disposed) dispose();
        else { unlisten = dispose; refresh(); }
      }).catch(console.error);
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      clock.dispose();
      unlisten?.();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
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
        <strong>{current.toLocaleDateString(inChinese ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" })}</strong>
      </div>
      <time className="current-time" dateTime={`${dateKey(current)}T${time}`}>{time}</time>
    </section>
  );
}

function parseDetailDate(value: string | null) {
  return (value ? parseCivilDate(value) : null) ?? new Date();
}

function DetailPanel() {
  const today = useVisibleToday();
  const language = useSettingsStore((state) => state.language);
  const modules = useSettingsStore((state) => state.modules);
  const { t, inChinese } = useMemo(() => translator(language), [language]);
  const [selected, setSelected] = useState(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    return parseDetailDate(date);
  });
  const [showHuangliDetails, setShowHuangliDetails] = useState(false);
  const [calculateHuangli, setCalculateHuangli] = useState<((date: Date) => Huangli) | null>(null);
  const huangli = useMemo(() => modules.almanac ? calculateHuangli?.(selected) ?? null : null, [calculateHuangli, selected, modules.almanac]);
  const hasHuangliDetails = !!(huangli?.zhushen || huangli?.taishen || huangli?.pengsheng);
  const selectedMeta = getCalendarMeta(selected);

  useEffect(() => {
    if (!modules.almanac) return;
    let active = true;
    void import("./services/huangli").then(({ getHuangli }) => {
      if (active) setCalculateHuangli(() => getHuangli);
    });
    return () => { active = false; };
  }, [modules.almanac]);

  useEffect(() => {
    let disposed = false;
    const listener = listen<string>("detail-date-changed", (event) => {
      if (!disposed) {
        setSelected(parseDetailDate(event.payload));
        setShowHuangliDetails(false);
      }
    });
    return () => { disposed = true; listener.then((dispose) => dispose()); };
  }, []);

  return (
    <main className="aux-shell detail-panel" aria-label={t("dateDetail")}>
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel: "detail" })} aria-label={t("settings.close")}>×</button>
      <div className="detail-topline">
        <img className="detail-mascot" src="/icon.png" alt="Doge" />
        <span className="detail-title">dogeCalendar</span>
        {dateKey(selected) === today && <span className="today-badge">{t("today")}</span>}
      </div>
      <div className="detail-date">
        <span className="detail-day">{selected.getDate()}</span>
        <div>
          <strong>{selected.toLocaleDateString(inChinese ? "zh-CN" : "en-US", { year: "numeric", month: "long" })}</strong>
          <span>{t(`weekday.full.${weekdayKeys()[selected.getDay()]}`)}</span>
        </div>
      </div>
      <div className="detail-lunar"><span>{selectedMeta.lunar}</span><span>{t("lunar")}</span></div>
      {modules.weather && <WeatherCard />}
      {modules.almanac && <><div className="detail-divider" />
      <div className="detail-almanac">
        <div className="detail-section"><span className="section-label">{t("almanac.yi")}</span><p>{huangli ? huangli.yi.join(" · ") : t("almanac.loading")}</p></div>
        <div className="detail-section detail-section-muted"><span className="section-label">{t("almanac.ji")}</span><p>{huangli ? huangli.ji.join(" · ") : t("almanac.loading")}</p></div>
      </div>
      <div className="huangli-meta">
        {huangli?.ganzhi && <span><i>{t("almanac.ganzhi")}</i>{huangli.ganzhi}</span>}
        {huangli?.shengxiao && <span className="huangli-zodiac"><i>{t("almanac.zodiac")}</i>{huangli.shengxiao}{hasHuangliDetails && (
          <button
            className="huangli-details-toggle"
            type="button"
            aria-label={t("almanac.details")}
            title={t("almanac.details")}
            aria-expanded={showHuangliDetails}
            aria-controls="huangli-details"
            onClick={() => setShowHuangliDetails((value) => !value)}
          >
            <svg className={showHuangliDetails ? "expanded" : ""} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="m3 6 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}</span>}
        {huangli?.xingzuo && <span><i>{t("almanac.constellation")}</i>{huangli.xingzuo}</span>}
        {huangli?.jieqi && <span><i>{t("almanac.term")}</i>{huangli.jieqi}</span>}
        {selectedMeta.holiday && <span><i>{t("almanac.festival")}</i>{selectedMeta.holiday}</span>}
      </div>
      {hasHuangliDetails && (
        <div className="side-holiday-card" id="huangli-details" hidden={!showHuangliDetails}>
          {huangli?.zhushen && <div className="holiday-lines"><p>{t("almanac.spirit")} · {huangli.zhushen}</p></div>}
          {huangli?.taishen && <div className="holiday-lines"><p>{t("almanac.fetal")} · {huangli.taishen}</p></div>}
          {huangli?.pengsheng && <div className="holiday-lines"><p>{t("almanac.pengzu")} · {huangli.pengsheng}</p></div>}
        </div>
      )}</>}
    </main>
  );
}

function AuxiliaryPanel({ panel }: { panel: "detail" | "clock" }) {
  const { t } = useTranslator();
  const clocksEnabled = useSettingsStore((state) => state.modules.worldClock);
  useAppearanceEffect();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) void invoke("close_aux_panel", { panel }).catch(console.error);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
  useEffect(() => {
    if (panel !== "clock" || !clocksEnabled) return;
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const start = () => {
      if (timer === undefined && !document.hidden) {
        timer = window.setInterval(() => void useInfoStore.getState().loadClocks().catch(console.error), 60000);
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const refresh = () => { if (!document.hidden) void useInfoStore.getState().loadClocks().catch(console.error); };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [panel, clocksEnabled]);
  if (panel === "detail") return <DetailPanel />;
  return (
    <main className="aux-shell clock-panel" aria-label={t("worldTime")}>
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel })} aria-label={t("settings.close")}>×</button>
      {clocksEnabled ? <WorldClockStrip /> : <p className="settings-description">{t("modules.disabled")}</p>}
    </main>
  );
}

export function App() {
  const panel = new URLSearchParams(window.location.search).get("panel");
  if (panel === "detail" || panel === "clock") return <AuxiliaryPanel panel={panel} />;
  return <CalendarApp />;
}

function CalendarApp() {
  const today = useVisibleToday();
  const isMac = document.documentElement.dataset.platform === "macos";
  const now = new Date();
  const { t, inChinese } = useTranslator();
  const theme = useSettingsStore((state) => state.theme);
  const calendar = useSettingsStore((state) => state.calendar);
  const updatePrefs = useSettingsStore((state) => state.update);
  const modules = useSettingsStore((state) => state.modules);
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState(now);
  const [view, setView] = useState<CalendarView>("month");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<"menu" | "update">("menu");
  const [infoPanel, setInfoPanel] = useState<"about" | null>(null);
  const [feedbackFailed, setFeedbackFailed] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateRelease, setUpdateRelease] = useState<UpdateCheck["release"]>(null);
  const [updateError, setUpdateError] = useState("");
  const [showToolbarMenu, setShowToolbarMenu] = useState(false);
  const [showDateJump, setShowDateJump] = useState(false);
  const [jumpInput, setJumpInput] = useState(() => dateKey(new Date()));
  const [jumpError, setJumpError] = useState("");
  const [holidayYears, setHolidayYears] = useState<Record<number, HolidayYear>>(getCachedHolidayYears);
  const wheelGesture = useRef({ lastEvent: -Infinity, delta: 0, handled: false });
  useAppearanceEffect();
  const days = useMemo(
    () => buildMonth(cursor.getFullYear(), cursor.getMonth(), holidayYears, calendar.weekStart, calendar.showWeekNumbers),
    [cursor, holidayYears, calendar.weekStart, calendar.showWeekNumbers, today],
  );

  const cursorYear = cursor.getFullYear();
  useEffect(() => {
    if (!modules.network || !calendar.showHolidays) cancelHolidayRequests();
  }, [modules.network, calendar.showHolidays]);
  useEffect(() => {
    if (!calendar.showHolidays) return;
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      const visibleYears = Array.from(new Set([Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1, ...(view === "year" ? [cursorYear] : days.map((day) => day.date.getFullYear()))]));
      void Promise.all(visibleYears.map(async (year) => {
        const data = await fetchHolidayYear(year, modules.network);
        if (active) setHolidayYears((current) => data ? { ...current, [year]: data } : { ...current });
      }));
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; document.removeEventListener("visibilitychange", refresh); };
   }, [cursorYear, cursor.getMonth(), view, calendar.showHolidays, modules.network, today]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(console.error);
    let active = true;
    if (!updatePrefs.autoCheck || !modules.network) return;
    void syncRuntimePreferences().then(() => updateApi.check(updatePrefs.includeBeta)).then(({ release, currentVersion }) => {
      if (!useSettingsStore.getState().modules.network) return;
      if (active) setAppVersion(currentVersion);
      if (!active || !release || localStorage.getItem(IGNORED_UPDATE_KEY) === release.version) return;
      setUpdateRelease(release);
      setUpdateStatus("available");
    }).catch((error) => console.error("启动时检查更新失败", error));
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkUpdates = async () => {
    setShowToolbarMenu(false);
    setInfoPanel(null);
    if (!useSettingsStore.getState().modules.network) {
      setUpdateError(t("modules.offline"));
      setUpdateStatus("error");
      setShowSettings(true);
      setSettingsView("update");
      return;
    }
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

  const installUpdate = async () => {
    if (!updateRelease || updateStatus === "installing" || !modules.network) return;
    setUpdateStatus("installing");
    setUpdateError("");
    try {
      await updateApi.install(updateRelease.version, updatePrefs.includeBeta);
    } catch (error) {
      setUpdateStatus("error");
      setUpdateError(String(error));
    }
  };

  const openSettings = () => {
    setInfoPanel(null);
    setShowSettings(true);
    setSettingsView("menu");
  };

  const showAbout = () => {
    setShowSettings(false);
    setShowToolbarMenu(false);
    setFeedbackFailed(false);
    setInfoPanel("about");
  };

  const moveMonth = (offset: number) => {
    setCursor((value) => {
      const next = new Date(value.getFullYear(), value.getMonth() + offset, 1);
      return next.getFullYear() >= 1900 && next.getFullYear() <= 2100 ? next : value;
    });
  };

  const moveYear = (offset: number) => {
    setCursor((value) => new Date(Math.max(1900, Math.min(2100, value.getFullYear() + offset)), value.getMonth(), 1));
  };

  const selectDate = (date: Date) => {
    if (date.getFullYear() < 1900 || date.getFullYear() > 2100) return;
    setSelected(date);
    setCursor((current) => current.getFullYear() === date.getFullYear() && current.getMonth() === date.getMonth()
      ? current : new Date(date.getFullYear(), date.getMonth(), 1));
    void invoke("open_aux_panel", { panel: "detail", date: dateKey(date) });
  };

  const jumpToDate = (event: React.FormEvent) => {
    event.preventDefault();
    const date = parseCivilDate(jumpInput);
    if (!date) { setJumpError(t("calendar.invalidDate")); return; }
    setView("month");
    selectDate(date);
    setShowDateJump(false);
    setJumpError("");
  };

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      if (showToolbarMenu) setShowToolbarMenu(false);
      else if (showDateJump) setShowDateJump(false);
      else if (showSettings) setShowSettings(false);
      else if (infoPanel) setInfoPanel(null);
      else if ("__TAURI_INTERNALS__" in window) void invoke("hide_calendar").catch(console.error);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [showToolbarMenu, showDateJump, showSettings, infoPanel]);

  useEffect(() => {
    if (!calendar.keyboardShortcut) return;
    const onKey = (event: KeyboardEvent) => {
    if (showSettings || infoPanel || showDateJump) return;
      const target = event.target as HTMLElement | null;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setShowDateJump(true);
        setShowToolbarMenu(false);
        return;
      }
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || target?.isContentEditable || target?.closest("input, select, textarea, [role='dialog']")) return;
      if (event.key === " " && target?.closest("button, summary, a")) return;
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
  }, [calendar.keyboardShortcut, showSettings, infoPanel, showDateJump]);

  const handleCalendarWheel = (event: React.WheelEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (showToolbarMenu || showDateJump || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || target.closest("input, select, textarea, [contenteditable='true']")) return;
    if (isMac) {
      const gesture = wheelGesture.current;
      if (event.timeStamp - gesture.lastEvent > 180) {
        gesture.delta = 0;
        gesture.handled = false;
      }
      gesture.lastEvent = event.timeStamp;
      if (gesture.handled) return;
      gesture.delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      if (Math.abs(gesture.delta) >= 40) {
        gesture.handled = true;
        moveMonth(gesture.delta < 0 ? -1 : 1);
      }
      return;
    }
    const gesture = wheelGesture.current;
    if (Math.abs(event.deltaX) === Math.abs(event.deltaY)) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    if (Math.abs(delta) < 8 || event.timeStamp - gesture.lastEvent < 160) return;
    gesture.lastEvent = event.timeStamp;
    moveMonth(delta < 0 ? -1 : 1);
  };

  const selectedKey = selected.toDateString();

  useEffect(() => {
    const listeners = [
       listen("taskbar-calendar-click", () => {
       setShowSettings(false);
       setInfoPanel(null);
        }),
      listen("open-settings", () => {
      openSettings();
      }),
      listen("open-update", () => {
      void checkUpdates();
      }),
      listen("open-about", () => {
      showAbout();
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

  const weekdayOrder = orderedWeekdays(calendar.weekStart);
  const showLunar = calendar.showLunar;
  const showHolidays = calendar.showHolidays;
  const holidayCountdown = showHolidays ? getHolidayCountdown(parseDetailDate(today), holidayYears) : null;
  const holidaySummary = holidayCountdown
    ? t(holidayCountdown.kind === "current" ? "calendar.holidayRemaining" : "calendar.holidayCountdown")
      .replace("{name}", holidayCountdown.name).replace("{days}", String(holidayCountdown.days))
    : t("calendar.holidayPending");
  const yearSummary = t("calendar.yearRemaining").replace("{days}", String(daysRemainingInYear(parseDetailDate(today))));

  return (
    <main className="calendar-shell">
      {infoPanel ? (
        <section className="settings-panel info-panel" aria-label={t("settings.about")}>
          <div className="settings-header">
            <div><h2>{t("settings.about")}</h2></div>
            <button className="settings-close" aria-label={t("settings.close")} onClick={() => setInfoPanel(null)}>×</button>
          </div>
          <div className="info-app"><img src="/icon.png" alt="" /><div><strong>dogeCalendar</strong><span>{t("update.currentVersion")} {appVersion || "…"}</span></div></div>
          <p className="settings-description">{t("about.tagline")}</p>
          <div className="info-actions">
            <button className="info-button primary" onClick={() => void checkUpdates()}>{t("update.checkNow")}</button>
            <button className="info-button" onClick={() => void openUrl(REPOSITORY_URL)}>{t("about.repo")}</button>
            <button className="info-button" type="button" onClick={() => {
              setFeedbackFailed(false);
              void openUrl(FEEDBACK_URL).catch(() => setFeedbackFailed(true));
            }}>{t("about.feedback")}</button>
          </div>
          {feedbackFailed && <p className="date-format-error" role="alert">{t("about.feedbackFailed")}</p>}
        </section>
      ) : showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onCheckUpdates={() => void checkUpdates()}
          onIgnoreVersion={ignoreUpdate}
          onInstallUpdate={() => void installUpdate()}
          appVersion={appVersion}
          updateStatus={updateStatus}
          updateRelease={updateRelease}
          updateError={updateError}
          initialView={settingsView}
        />
       ) : <><StorageNotice /><CurrentDateTime /><div className="calendar-layout">
        <section className="calendar-area" aria-label={t("settings.calendar")}>
        <header className="calendar-header">
          <div className="month-control">
            <button aria-label={t("calendar.previousMonth")} title={t("calendar.previousMonth")} onClick={() => moveMonth(-1)}>‹</button>
            <select
              className="calendar-select"
              aria-label={t("settings.calendar")}
              value={cursor.getMonth()}
              onChange={(event) => setCursor(new Date(cursor.getFullYear(), Number(event.target.value), 1))}
            >
               {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{new Date(2026, month, 1).toLocaleDateString(inChinese ? "zh-CN" : "en-US", { month: "short" })}</option>)}
            </select>
            <button aria-label={t("calendar.nextMonth")} title={t("calendar.nextMonth")} onClick={() => moveMonth(1)}>›</button>
          </div>
          <select
            className="calendar-select calendar-select-year"
            aria-label={t("settings.calendar")}
            value={cursor.getFullYear()}
            onChange={(event) => setCursor(new Date(Number(event.target.value), cursor.getMonth(), 1))}
          >
            {Array.from({ length: 201 }, (_, offset) => {
              const year = 1900 + offset;
               return <option key={year} value={year}>{year}{inChinese ? "年" : ""}</option>;
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
                  {modules.worldClock && <button
                    role="menuitem"
                    className="toolbar-menu-item"
                    onClick={() => { void invoke("open_aux_panel", { panel: "clock" }); setShowToolbarMenu(false); }}
                  >
                    <span className="toolbar-menu-check" />
                    <span>{t("menu.worldClock")}</span>
                  </button>}
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => { setView(view === "month" ? "year" : "month"); setShowToolbarMenu(false); }}>
                    <span className="toolbar-menu-check" /><span>{t(view === "month" ? "calendar.yearView" : "calendar.monthView")}</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => { setShowDateJump(true); setShowToolbarMenu(false); }}>
                    <span className="toolbar-menu-check" /><span>{t("calendar.jump")}</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => { openSettings(); setShowToolbarMenu(false); }}>
                    <span className="toolbar-menu-check" /><span>{t("menu.settings")}</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => void checkUpdates()}>
                    <span className="toolbar-menu-check">{updateStatus === "available" ? "•" : ""}</span><span>{t("menu.onlineUpdate")}</span>
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
        {showDateJump && <form className="popover date-jump" role="dialog" aria-label={t("calendar.jump")} onSubmit={jumpToDate} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setShowDateJump(false); } }}>
          <button type="button" className="popover-close" aria-label={t("settings.close")} onClick={() => setShowDateJump(false)}>×</button>
          <label htmlFor="jump-date">{t("calendar.jump")}</label>
          <input id="jump-date" type="date" min="1900-01-01" max="2100-12-31" className="settings-select" value={jumpInput} onChange={(event) => setJumpInput(event.target.value)} autoFocus required />
          <button className="info-button" type="submit">{t("calendar.go")}</button>
          {jumpError && <span className="date-format-error" role="alert">{jumpError}</span>}
        </form>}
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
                     aria-label={`${day.date.toLocaleDateString(inChinese ? "zh-CN" : "en-US", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}${showHolidays && day.isWorkday ? ` ${t("calendar.work")}` : ""}${showHolidays && day.isRest ? ` ${t("calendar.rest")}` : ""}`}
                    onClick={() => selectDate(day.date)}
                    title={`${dateKey(day.date)} ${day.holiday ?? day.label ?? day.lunarLabel}`}
                    aria-pressed={selectedDay}
                    aria-current={day.isToday ? "date" : undefined}
                  >
                    {day.weekNumber !== undefined && <b className="week-mark">{t("week")}{day.weekNumber}</b>}
                     <span className="solar-day">{day.date.getDate()}{showHolidays && day.isWorkday && <b className="work-mark">{t("calendar.work")}</b>}</span>
                    <span className={`lunar-day ${showHolidays && (day.holiday || day.label) ? "special-day" : ""}`}>
                       {(showHolidays ? day.holiday : undefined) ?? (showLunar ? day.label ?? day.lunarLabel : "")}
                    </span>
                     {showHolidays && day.isRest && <b className="rest-mark">{t("calendar.rest")}</b>}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="year-grid" aria-label={`${cursor.getFullYear()} ${t("calendar.yearView")}`}>
             {Array.from({ length: 12 }, (_, month) => (
              <section className="mini-month" key={month}>
                <button className="mini-month-title" onClick={() => { setCursor(new Date(cursor.getFullYear(), month, 1)); setView("month"); }}>{new Date(cursor.getFullYear(), month, 1).toLocaleDateString(inChinese ? "zh-CN" : "en-US", { month: "short" })}</button>
                <div className="mini-weekdays">{weekdayOrder.map((dayIndex) => <span key={dayIndex}>{t(`weekday.${weekdayKeys()[dayIndex]}`)}</span>)}</div>
                  <div className="mini-month-grid">{buildMonth(cursor.getFullYear(), month, holidayYears, calendar.weekStart, false).map((day) => <button key={day.date.toISOString()} className={`${day.isCurrentMonth ? "" : "muted"} ${day.isToday ? "today" : ""} ${showHolidays && day.isRest ? "holiday-cell" : ""} ${showHolidays && day.isWorkday ? "workday-cell" : ""}`} aria-label={day.date.toLocaleDateString(inChinese ? "zh-CN" : "en-US")} title={`${dateKey(day.date)} ${day.holiday ?? ""} ${day.isRest ? t("calendar.restDay") : day.isWorkday ? t("calendar.workDay") : ""}`} onClick={() => { setView("month"); selectDate(day.date); }}>{day.date.getDate()}</button>)}</div>
              </section>
            ))}
          </div>
        )}
        {view === "year" && <p className="calendar-data-note">{t("calendar.yearLegend")}</p>}
         <div className="calendar-countdown-summary" role="status">
           {showHolidays && (holidayCountdown
             ? <button className="calendar-countdown-holiday" onClick={() => selectDate(parseDetailDate(holidayCountdown.date))} title={`${holidaySummary} · ${holidayCountdown.date}${holidayCountdown.kind === "current" ? ` · ${t("calendar.remainingIncludesToday")}` : ""}`}>{holidaySummary}</button>
             : <span>{holidaySummary}</span>)}
           <span title={t("calendar.remainingExcludesToday")}>{yearSummary}</span>
         </div>
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
