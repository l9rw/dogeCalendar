import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCalendarMeta } from "./services/calendarData";

type CalendarDay = {
  date: Date;
  lunar: string;
  lunarDay: string;
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
      lunar: meta.lunar,
      lunarDay: meta.lunarDay,
      label: meta.solarTerm,
      holiday: meta.holiday,
      isCurrentMonth: date.getMonth() === month,
      isToday: date.toDateString() === today.toDateString(),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
      isRest: meta.holidayStatus === "rest",
      isWorkday: meta.holidayStatus === "workday" && Boolean(meta.holiday),
      holidayType: meta.holidayType,
    };
  });
}

export function App() {
  const now = new Date();
  const [cursor, setCursor] = useState(new Date(2026, 8, 1));
  const [selected, setSelected] = useState(now);
  const [view, setView] = useState<CalendarView>("month");
  const [contextMenu, setContextMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const days = useMemo(() => buildMonth(cursor.getFullYear(), cursor.getMonth()), [cursor]);

  const moveMonth = (offset: number) => {
    setCursor((value) => new Date(value.getFullYear(), value.getMonth() + offset, 1));
  };

  const selectDate = (date: Date) => {
    setSelected(date);
    setCursor(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  const handleCalendarWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) >= 8) moveMonth(event.deltaY < 0 ? -1 : 1);
  };

  const selectedKey = selected.toDateString();
  const selectedMeta = getCalendarMeta(selected);

  useEffect(() => {
    const disposers: Array<() => void> = [];
    listen("taskbar-calendar-click", () => {
      setContextMenu(false);
      setShowSettings(false);
    }).then((dispose) => disposers.push(dispose));
    listen("taskbar-calendar-context", () => {
      setContextMenu(true);
      setShowSettings(false);
    }).then((dispose) => disposers.push(dispose));
    return () => disposers.forEach((dispose) => dispose());
  }, []);
  const selectedIsToday = selectedKey === now.toDateString();

  return (
    <main className="calendar-shell">
      {contextMenu ? (
        <div className="taskbar-context-menu" role="menu">
          <button role="menuitem" onClick={() => setContextMenu(false)}>打开日历</button>
          <button role="menuitem" onClick={() => { setShowSettings(true); setContextMenu(false); }}>设置</button>
          <button role="menuitem" onClick={() => invoke("quit_app")}>退出</button>
        </div>
      ) : showSettings ? (
        <section className="settings-panel" aria-label="设置">
          <div className="settings-header">
            <div><p className="eyebrow">CALENDAR SETTINGS</p><h2>设置</h2></div>
            <button className="settings-close" onClick={() => setShowSettings(false)}>×</button>
          </div>
          <p className="settings-description">日历面板由 Windows 任务栏右下角时间控件触发。</p>
        </section>
      ) : <div className="calendar-layout">
        <aside className="detail-panel" aria-label="日期详情">
          <div className="detail-topline">
            <span className="detail-caption">日期详情</span>
            {selectedIsToday && <span className="today-badge">今天</span>}
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
          <div className="detail-section"><span className="section-label">宜</span><p>安排行程 · 处理工作 · 整理生活</p></div>
          <div className="detail-section detail-section-muted"><span className="section-label">节日</span><p>{selectedMeta.holiday ?? "暂无节日安排"}</p></div>
          <button className="detail-today" onClick={() => selectDate(new Date())}>回到今天</button>
          <div className="side-holiday-card">
            <div className="footer-links"><span>节日百科</span><span>秋分⌕</span></div>
            <div className="holiday-summary">
              <div className="holiday-date"><strong>{selectedMeta.lunar}</strong><b>{selectedMeta.holiday ?? (selectedMeta.holidayStatus === "rest" ? "周末休息" : selectedMeta.holidayStatus === "workday" ? "调休上班" : "普通工作日")}</b></div>
              <div className="holiday-lines"><p><i className="red-icon">宜</i> 安排行程·处理工作·整理生活</p><p><i className="dark-icon">忌</i> 忽略休息·临时拖延</p></div>
            </div>
            <div className="countdown">◷ &nbsp;{selectedMeta.holiday ? `${selectedMeta.holiday} · ${selectedMeta.holidayStatus === "workday" ? "调休上班" : "休息日"}` : "暂无年度节假日安排"}</div>
          </div>
        </aside>

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
            {Array.from({ length: 21 }, (_, offset) => {
              const year = now.getFullYear() - 10 + offset;
              return <option key={year} value={year}>{year}年</option>;
            })}
          </select>
          <button className="today-button" onClick={() => selectDate(new Date())}>今天</button>
        </header>

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
                    className={`day-cell ${day.isCurrentMonth ? "" : "muted"} ${day.isWeekend ? "weekend" : ""} ${selectedDay ? "selected" : ""} ${day.isRest ? "holiday-cell" : ""} ${day.isWorkday ? "workday-cell" : ""}`}
                    key={day.date.toISOString()}
                    onClick={() => selectDate(day.date)}
                  >
                    <span className="solar-day">{day.date.getDate()}{day.isWorkday && <b className="work-mark">班</b>}</span>
                    <span className={`lunar-day ${day.holiday || day.label ? "special-day" : ""}`}>
                      {day.isToday ? "今天" : day.holiday ?? day.label ?? day.lunarDay}
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

        </section>
      </div>}
    </main>
  );
}
