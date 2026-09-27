import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCalendarMeta, dateKey } from "./services/calendarData";
import { fetchHuangli, type Huangli } from "./services/huangli";
import { useInfoStore } from "./stores/infoStore";
import type { WeatherReport } from "./services/ipc";
import { WeatherCard } from "./components/WeatherCard";
import { WorldClockStrip } from "./components/WorldClockStrip";

type CalendarDay = {
  date: Date;
  lunarLabel: string;
  label?: string;
  holiday?: string;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  isRest: boolean;
  isWorkday: boolean;
  holidayType: "holiday" | "rest" | "workday" | "none";
};

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
type CalendarView = "month" | "year";
type ThemeMode = "light" | "dark" | "system";
type MenuBarStyle = "calendar" | "date" | "weekday_date";
const THEME_KEY = "calendar-theme";
const IGNORED_UPDATE_KEY = "calendar-ignored-update";
const REPOSITORY_URL = "https://github.com/l9rw/dogeCalendar";
type UpdateCheck = { currentVersion: string; hasRelease: boolean; release: { version: string; url: string } | null };
let startupUpdateCheck: Promise<UpdateCheck> | undefined;

export function resolveTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem(THEME_KEY) as ThemeMode) || "system");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const effective = resolveTheme(mode, systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
  }, [effective]);
  const changeTheme = (next: ThemeMode) => {
    setMode(next);
    localStorage.setItem(THEME_KEY, next);
  };
  return { mode, changeTheme };
}

function startOfCalendarGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 - ((first.getDay() + 6) % 7));
}

function buildMonth(year: number, month: number): CalendarDay[] {
  const start = startOfCalendarGrid(year, month);
  const today = new Date();
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const day = date.getDate();
    const meta = getCalendarMeta(date);
    return {
      date,
      lunarLabel: meta.lunarDay === "初一" ? meta.lunar.slice(0, -meta.lunarDay.length) : meta.lunarDay || meta.lunar,
      label: meta.solarTerm,
      holiday: meta.holiday,
      isCurrentMonth: date.getMonth() === month,
      isToday: date.toDateString() === today.toDateString(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
      isRest: (meta.holidayStatus === "rest" || meta.holidayStatus === "holiday") && Boolean(meta.holiday),
      isWorkday: meta.holidayStatus === "workday" && Boolean(meta.holiday),
      holidayType: meta.holidayType,
    };
  });
}

function DetailPanel() {
  const [selected, setSelected] = useState(() => {
    const date = new URLSearchParams(window.location.search).get("date");
    return date ? new Date(`${date}T12:00:00`) : new Date();
  });
  const [huangli, setHuangli] = useState<Huangli | null>(null);
  const [huangliLoading, setHuangliLoading] = useState(false);
  const selectedKey = dateKey(selected);
  const selectedMeta = getCalendarMeta(selected);

  useEffect(() => {
    let disposed = false;
    const listener = listen<string>("detail-date-changed", (event) => {
      if (!disposed) setSelected(new Date(`${event.payload}T12:00:00`));
    });
    return () => { disposed = true; listener.then((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHuangli(null);
    setHuangliLoading(true);
    fetchHuangli(selectedKey)
      .then((data) => { if (!cancelled) setHuangli(data); })
      .catch(() => { if (!cancelled) setHuangli(null); })
      .finally(() => { if (!cancelled) setHuangliLoading(false); });
    return () => { cancelled = true; };
  }, [selectedKey]);

  return (
    <main className="aux-shell detail-panel" aria-label="日期详情">
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel: "detail" })} aria-label="关闭">×</button>
      <WeatherCard />
      <div className="detail-topline">
        <span className="detail-caption">日期详情</span>
        {selected.toDateString() === new Date().toDateString() && <span className="today-badge">今天</span>}
      </div>
      <div className="detail-date">
        <span className="detail-day">{selected.getDate()}</span>
        <div>
          <strong>{selected.getFullYear()}年{selected.getMonth() + 1}月</strong>
          <span>{["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][selected.getDay()]}</span>
        </div>
      </div>
      <div className="detail-lunar"><span>{selectedMeta.lunar}</span><span>农历</span></div>
      <div className="detail-divider" />
      <div className="detail-section"><span className="section-label">宜</span><p className="yi-list">{huangli?.yi?.length ? huangli.yi.join(" · ") : huangliLoading ? "加载中…" : "暂无宜事"}</p></div>
      <div className="detail-section detail-section-muted"><span className="section-label">忌</span><p className="ji-list">{huangli?.ji?.length ? huangli.ji.join(" · ") : huangliLoading ? "加载中…" : "暂无忌事"}</p></div>
      <div className="huangli-meta">
        {huangli?.ganzhi && <span><i>干支</i>{huangli.ganzhi}</span>}
        {huangli?.shengxiao && <span><i>生肖</i>{huangli.shengxiao}</span>}
        {huangli?.xingzuo && <span><i>星座</i>{huangli.xingzuo}</span>}
        {huangli?.jieqi && <span><i>节气</i>{huangli.jieqi}</span>}
        {selectedMeta.holiday && <span><i>节日</i>{selectedMeta.holiday}</span>}
      </div>
      <div className="side-holiday-card">
        {huangli?.zhushen && <div className="holiday-lines"><p><i className="dark-icon">神</i>值神 · {huangli.zhushen}</p></div>}
        {huangli?.taishen && <div className="holiday-lines"><p><i className="dark-icon">胎</i>{huangli.taishen}</p></div>}
        {huangli?.pengsheng && <div className="holiday-lines"><p><i className="red-icon">忌</i>{huangli.pengsheng}</p></div>}
        {!huangli && !huangliLoading && <div className="holiday-lines"><p><i className="dark-icon">·</i>黄历接口暂时不可用</p></div>}
      </div>
    </main>
  );
}

function AuxiliaryPanel({ panel }: { panel: "detail" | "clock" }) {
  useThemeMode();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") invoke("close_aux_panel", { panel });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
  useEffect(() => {
    if (panel !== "clock") return;
    const tick = () => { if (!document.hidden) void useInfoStore.getState().loadClocks(); };
    const timer = window.setInterval(tick, 15000);
    return () => window.clearInterval(timer);
  }, [panel]);
  if (panel === "detail") return <DetailPanel />;
  return (
    <main className="aux-shell clock-panel" aria-label="世界时间">
      <button className="popover-close" onClick={() => invoke("close_aux_panel", { panel })} aria-label="关闭">×</button>
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
  const [cursor, setCursor] = useState(new Date(2026, 8, 1));
  const [selected, setSelected] = useState(now);
  const [view, setView] = useState<CalendarView>("month");
  const [contextMenu, setContextMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [infoPanel, setInfoPanel] = useState<"update" | "about" | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "current" | "unreleased" | "available" | "error">("idle");
  const [updateRelease, setUpdateRelease] = useState<UpdateCheck["release"]>(null);
  const [updateError, setUpdateError] = useState("");
  const [showToolbarMenu, setShowToolbarMenu] = useState(false);
  const [menuBarStyle, setMenuBarStyle] = useState<MenuBarStyle>("calendar");
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const setManualLocation = useInfoStore((state) => state.setManualLocation);
  const clearLocation = useInfoStore((state) => state.clearLocation);
  const clearWeatherCache = useInfoStore((state) => state.clearWeatherCache);
  const { mode: themeMode, changeTheme } = useThemeMode();
  const days = useMemo(() => buildMonth(cursor.getFullYear(), cursor.getMonth()), [cursor]);

  useEffect(() => {
    void getVersion().then(setAppVersion).catch(console.error);
    let active = true;
    startupUpdateCheck ??= invoke<UpdateCheck>("check_for_updates");
    void startupUpdateCheck.then(async ({ release, currentVersion }) => {
      if (active) setAppVersion(currentVersion);
      if (!active || !release || localStorage.getItem(IGNORED_UPDATE_KEY) === release.version) return;
      setUpdateRelease(release);
      setUpdateStatus("available");
      setShowSettings(false);
      setContextMenu(false);
      setInfoPanel("update");
      await invoke("show_update_panel");
    }).catch((error) => console.error("启动时检查更新失败", error));
    return () => { active = false; };
  }, []);

  const checkUpdates = async () => {
    setContextMenu(false);
    setShowSettings(false);
    setShowToolbarMenu(false);
    setInfoPanel("update");
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const result = await invoke<UpdateCheck>("check_for_updates");
      setAppVersion(result.currentVersion);
      setUpdateRelease(result.release);
      setUpdateStatus(result.release ? "available" : result.hasRelease ? "current" : "unreleased");
    } catch (error) {
      setUpdateStatus("error");
      setUpdateError(String(error));
    }
  };

  const showAbout = () => {
    setContextMenu(false);
    setShowSettings(false);
    setShowToolbarMenu(false);
    setInfoPanel("about");
  };

  useEffect(() => {
    if (!isMac) return;
    let active = true;
    void invoke<MenuBarStyle>("menu_bar_style_get").then((style) => {
      if (active) setMenuBarStyle(style);
    }).catch(console.error);
    return () => { active = false; };
  }, [isMac]);

  const changeMenuBarStyle = async (style: MenuBarStyle) => {
    try {
      await invoke("menu_bar_style_set", { style });
      setMenuBarStyle(style);
    } catch (error) {
      console.error("无法更新菜单栏图标", error);
    }
  };

  const moveMonth = (offset: number) => {
    setCursor((value) => new Date(value.getFullYear(), value.getMonth() + offset, 1));
  };

  const selectDate = (date: Date) => {
    setSelected(date);
    setCursor(new Date(date.getFullYear(), date.getMonth(), 1));
    void invoke("open_aux_panel", { panel: "detail", date: dateKey(date) });
  };

  const handleCalendarWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) >= 8) moveMonth(event.deltaY < 0 ? -1 : 1);
  };

  const selectedKey = selected.toDateString();

  useEffect(() => {
    const disposers: Array<() => void> = [];
    listen("taskbar-calendar-click", () => {
      setContextMenu(false);
      setShowSettings(false);
      setInfoPanel(null);
    }).then((dispose) => disposers.push(dispose));
    listen("taskbar-calendar-context", () => {
      setContextMenu(true);
      setShowSettings(false);
      setInfoPanel(null);
    }).then((dispose) => disposers.push(dispose));
    listen("open-settings", () => {
      setContextMenu(false);
      setInfoPanel(null);
      setShowSettings(true);
    }).then((dispose) => disposers.push(dispose));
    return () => disposers.forEach((dispose) => dispose());
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

  return (
    <main className="calendar-shell">
      {contextMenu ? (
        <div className="taskbar-context-menu" role="menu">
          <button role="menuitem" onClick={() => setContextMenu(false)}>打开日历</button>
          <button role="menuitem" onClick={() => { setShowSettings(true); setContextMenu(false); }}>设置</button>
          {isMac && <button role="menuitem" onClick={() => { setShowSettings(true); setContextMenu(false); }}>标题栏设置</button>}
          <button role="menuitem" onClick={() => void checkUpdates()}>在线更新</button>
          <button role="menuitem" onClick={showAbout}>关于</button>
          <button role="menuitem" onClick={() => invoke("quit_app")}>退出</button>
        </div>
      ) : infoPanel ? (
        <section className="settings-panel info-panel" aria-label={infoPanel === "about" ? "关于" : "在线更新"}>
          <div className="settings-header">
            <div><p className="eyebrow">{infoPanel === "about" ? "ABOUT dogeCalendar" : "SOFTWARE UPDATE"}</p><h2>{infoPanel === "about" ? "关于" : "在线更新"}</h2></div>
            <button className="settings-close" aria-label="关闭" onClick={() => setInfoPanel(null)}>×</button>
          </div>
          {infoPanel === "about" ? <>
            <div className="info-app"><img src="/icon.png" alt="" /><div><strong>dogeCalendar</strong><span>版本 {appVersion || "获取中…"}</span></div></div>
            <p className="settings-description">轻量桌面日历，提供农历、天气与世界时钟。</p>
            <div className="info-actions">
              <button className="info-button primary" onClick={() => void checkUpdates()}>检查更新</button>
              <button className="info-button" onClick={() => void openUrl(REPOSITORY_URL)}>GitHub 仓库</button>
            </div>
          </> : <>
            <p className="settings-description">当前版本：{appVersion || "获取中…"}</p>
            <div className="update-message" role="status">
              {updateStatus === "checking" && "正在检查 GitHub 最新发布版本…"}
              {updateStatus === "current" && "已是最新版本。"}
              {updateStatus === "unreleased" && "仓库目前没有公开发布的版本。"}
              {updateStatus === "available" && updateRelease && <><strong>发现新版本 v{updateRelease.version}</strong><span>可前往 GitHub Release 下载并安装更新。</span></>}
              {updateStatus === "error" && <>检查失败：{updateError}</>}
              {updateStatus === "idle" && "点击检查更新以获取最新版本。"}
            </div>
            <div className="info-actions">
              {updateStatus === "available" && updateRelease ? <>
                <button className="info-button primary" onClick={() => void openUrl(updateRelease.url)}>前往更新</button>
                <button className="info-button" onClick={() => { localStorage.setItem(IGNORED_UPDATE_KEY, updateRelease.version); setInfoPanel(null); }}>忽略此版本</button>
              </> : <button className="info-button primary" disabled={updateStatus === "checking"} onClick={() => void checkUpdates()}>重新检查</button>}
            </div>
          </>}
        </section>
      ) : showSettings ? (
        <section className="settings-panel" aria-label="设置">
          <div className="settings-header">
            <div><p className="eyebrow">CALENDAR SETTINGS</p><h2>设置</h2></div>
            <button className="settings-close" onClick={() => setShowSettings(false)}>×</button>
          </div>
          <p className="settings-description">日历面板可由 Windows 任务栏时间控件或 macOS 菜单栏图标触发。</p>
          <div className="settings-section">
            <span className="section-label">外观</span>
            <div className="theme-options">
              {([["light", "日间模式", "始终使用浅色主题"], ["dark", "夜间模式", "始终使用深色主题"], ["system", "跟随系统", "根据系统设置自动切换"]] as const).map(([value, label, desc]) => (
                <button key={value} className={`theme-option ${themeMode === value ? "active" : ""}`} onClick={() => changeTheme(value)}>
                  <span className={`theme-dot ${value}`} />
                  <span className="theme-label">{label}</span>
                  <span className="theme-desc">{desc}</span>
                </button>
              ))}
            </div>
          </div>
          {isMac && <div className="settings-section">
            <span className="section-label">标题栏设置</span>
            <div className="theme-options">
              {([ ["calendar", "日历图标", "默认图标"], ["date", "显示当天的日期", "菜单栏显示今日日期"], ["weekday_date", "周几 + 日期", "上面显示周几，下面显示日期"] ] as const).map(([value, label, desc]) => (
                <button key={value} className={`theme-option ${menuBarStyle === value ? "active" : ""}`} aria-pressed={menuBarStyle === value} onClick={() => void changeMenuBarStyle(value)}>
                  <span className="theme-label">{label}</span>
                  <span className="theme-desc">{desc}</span>
                </button>
              ))}
            </div>
          </div>}
          <div className="settings-section">
            <span className="section-label">位置与天气</span>
            <p className="settings-description">手动设置坐标会覆盖 IP 定位；清除后会重新使用 IP 兜底。</p>
            <div className="location-form">
              <input className="location-input" placeholder="纬度" value={manualLat} onChange={(event) => setManualLat(event.target.value)} inputMode="decimal" />
              <input className="location-input" placeholder="经度" value={manualLon} onChange={(event) => setManualLon(event.target.value)} inputMode="decimal" />
              <input className="location-input location-input-wide" placeholder="城市/地点名称" value={manualLabel} onChange={(event) => setManualLabel(event.target.value)} />
              <button
                className="location-apply"
                onClick={() => {
                  const latitude = Number(manualLat);
                  const longitude = Number(manualLon);
                  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
                  setManualLocation(latitude, longitude, manualLabel || "自定义位置");
                  setManualLat("");
                  setManualLon("");
                  setManualLabel("");
                  setShowSettings(false);
                }}
              >
                应用
              </button>
            </div>
            <div className="location-actions">
              <button className="location-action" onClick={() => { clearLocation(); }}>清除定位</button>
              <button className="location-action" onClick={() => { clearWeatherCache(); }}>清除天气缓存</button>
            </div>
          </div>
        </section>
      ) : <><div className="calendar-layout">
        <section className="calendar-area" aria-label="月视图">
        <header className="calendar-header">
          <div className="month-control">
            <button aria-label="上个月" onClick={() => moveMonth(-1)}>‹</button>
            <select
              className="calendar-select"
              aria-label="月份"
              value={cursor.getMonth()}
              onChange={(event) => setCursor(new Date(cursor.getFullYear(), Number(event.target.value), 1))}
            >
              {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{month + 1}月</option>)}
            </select>
            <button aria-label="下个月" onClick={() => moveMonth(1)}>›</button>
          </div>
          <select
            className="calendar-select calendar-select-year"
            aria-label="年份"
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
              aria-label="返回今天"
              title="返回今天"
              onClick={() => selectDate(new Date())}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" fill="currentColor" />
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="toolbar-icon"
              aria-label="日期详情"
              title="日期详情"
              onClick={() => void invoke("open_aux_panel", { panel: "detail", date: dateKey(selected) })}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M3.5 9.5h17" stroke="currentColor" strokeWidth="1.6" />
                <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="8.5" cy="14.5" r="1.3" fill="currentColor" />
              </svg>
            </button>
            <button
              className="toolbar-icon toolbar-menu-toggle"
              aria-label="更多"
              title="更多"
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
                    <span>世界时钟</span>
                  </button>
                  {isMac && <button
                    role="menuitem"
                    className="toolbar-menu-item"
                    onClick={() => { setShowSettings(true); setShowToolbarMenu(false); }}
                  >
                    <span className="toolbar-menu-check" />
                    <span>标题栏设置</span>
                  </button>}
                  <button role="menuitem" className="toolbar-menu-item" onClick={() => void checkUpdates()}>
                    <span className="toolbar-menu-check" /><span>在线更新</span>
                  </button>
                  <button role="menuitem" className="toolbar-menu-item" onClick={showAbout}>
                    <span className="toolbar-menu-check" /><span>关于</span>
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
              {weekdays.map((weekday, index) => <span className={index > 4 ? "weekend-heading" : ""} key={weekday}>{weekday}</span>)}
            </div>
            <div className="month-grid">
              {days.map((day) => {
                const selectedDay = selectedKey === day.date.toDateString();
                return (
                  <button
                    className={`day-cell ${day.isCurrentMonth ? "" : "muted"} ${day.isWeekend ? "weekend" : ""} ${selectedDay ? "selected" : ""} ${day.isToday ? "today" : ""} ${day.isRest ? "holiday-cell" : ""} ${day.isWorkday ? "workday-cell" : ""}`}
                    key={day.date.toISOString()}
                    onClick={() => selectDate(day.date)}
                    aria-current={day.isToday ? "date" : undefined}
                  >
                    <span className="solar-day">{day.date.getDate()}{day.isWorkday && <b className="work-mark">班</b>}</span>
                    <span className={`lunar-day ${day.holiday || day.label ? "special-day" : ""}`}>
                      {day.holiday ?? day.label ?? day.lunarLabel}
                    </span>
                    {day.isRest && <b className="rest-mark">休</b>}
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
                <div className="mini-weekdays">{weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
                <div className="mini-month-grid">{buildMonth(cursor.getFullYear(), month).map((day) => <button key={day.date.toISOString()} className={`${day.isCurrentMonth ? "" : "muted"} ${day.isToday ? "today" : ""}`} onClick={() => selectDate(day.date)}>{day.date.getDate()}</button>)}</div>
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
