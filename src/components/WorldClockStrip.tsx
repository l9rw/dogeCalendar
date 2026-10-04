import { useEffect, useMemo, useRef, useState } from "react";
import { useInfoStore } from "../stores/infoStore";
import type { City } from "../services/ipc";
import { useSettingsStore } from "../stores/settingsStore";
import { translator } from "../data/i18n";
import { relativeOffsetMinutes, localizedClockDate } from "../services/worldClock";

export function WorldClockStrip() {
  const language = useSettingsStore((state) => state.language);
  const { t, inChinese } = translator(language);
  const [localNow, setLocalNow] = useState(() => new Date());
  const [error, setError] = useState("");
  const locale = inChinese ? "zh-CN" : "en-US";
  const clocks = useInfoStore((state) => state.clocks);
  const use24Hour = useInfoStore((state) => state.use24Hour);
  const loadClocks = useInfoStore((state) => state.loadClocks);
  const loadUse24Hour = useInfoStore((state) => state.loadUse24Hour);
  const setUse24Hour = useInfoStore((state) => state.setUse24Hour);
  const removeClock = useInfoStore((state) => state.removeClock);
  const reorderClocks = useInfoStore((state) => state.reorderClocks);
  const addClock = useInfoStore((state) => state.addClock);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    void Promise.all([loadUse24Hour(), loadClocks()]).catch((failure) => setError(String(failure)));
  }, [loadUse24Hour, loadClocks]);

  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      setLocalNow(new Date());
      timer = window.setTimeout(update, 60000 - Date.now() % 60000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); };
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const search = useInfoStore.getState().search;
    void search(query).catch((failure) => setError(String(failure)));
  }, [pickerOpen, query]);

  const results = useInfoStore((state) => state.searchResults);
  const candidates = useMemo(() => {
    const pinnedTzs = new Set(clocks.map((clock) => clock.timezone));
    return results.filter((city) => !pinnedTzs.has(city.timezone)).slice(0, 8);
  }, [clocks, results]);

  const onDragStart = (index: number) => {
    dragIndex.current = index;
  };
  const onDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === index) return;
    const next = [...clocks];
    const [moved] = next.splice(from, 1);
    next.splice(index, 0, moved);
    dragIndex.current = index;
    useInfoStore.setState({ clocks: next });
  };
  const onDragEnd = () => {
    if (dragIndex.current === null) return;
    void reorderClocks(useInfoStore.getState().clocks.map((clock) => clock.timezone)).catch((failure) => setError(String(failure)));
    dragIndex.current = null;
  };

  return (
    <section className="world-clock-strip" aria-label={t("worldTime")}>
      <div className="world-clock-header">
        <span className="world-clock-title">{t("worldTime")}</span>
        <button
          className={`world-clock-format ${use24Hour ? "active" : ""}`}
          onClick={() => void setUse24Hour(!use24Hour).catch((failure) => setError(String(failure)))}
          title={t("worldClock.format")}
        >
          {use24Hour ? "24h" : "12h"}
        </button>
        <button
          className="world-clock-add"
          onClick={() => setPickerOpen((value) => !value)}
          title={t("worldClock.add")}
        >
          ＋
        </button>
      </div>

      {pickerOpen && (
        <div className="world-clock-picker">
          <input
            className="world-clock-search"
            autoFocus
            placeholder={t("worldClock.search")}
            aria-label={t("worldClock.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="world-clock-results">
            {candidates.length === 0 ? (
              <span className="world-clock-empty">{t("worldClock.empty")}</span>
            ) : (
              candidates.map((city: City) => (
                <button
                  key={city.timezone}
                  className="world-clock-result"
                  onClick={() => {
                    void addClock(city).catch((failure) => setError(String(failure)));
                    setQuery("");
                  }}
                >
                  <span>{city.label}</span>
                  <small>{city.timezone}</small>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="world-clock-list">
        <div className="world-clock-item local-clock">
          <div className="world-clock-time"><strong>{localNow.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: !use24Hour })}</strong><span>{t("worldClock.local")}</span></div>
          <div className="world-clock-place"><span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span><small>{localNow.toLocaleDateString(locale, { month: "short", day: "numeric", weekday: "short" })}</small></div>
        </div>
        {clocks.map((clock, index) => (
          <div
            key={clock.timezone}
            className="world-clock-item"
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(event) => onDragOver(event, index)}
            onDragEnd={onDragEnd}
          >
            <div className="world-clock-time">
              <strong>{use24Hour ? clock.time_24 : clock.time_12}</strong>
              <span title={t("worldClock.relative")}>{(() => {
                const delta = relativeOffsetMinutes(clock.offset_minutes, localNow.getTimezoneOffset());
                if (!delta) return t("worldClock.same");
                const absolute = Math.abs(delta);
                return `${t(delta > 0 ? "worldClock.ahead" : "worldClock.behind")} ${Math.floor(absolute / 60)} ${t("worldClock.hours")}${absolute % 60 ? ` ${absolute % 60} ${t("worldClock.minutes")}` : ""}`;
              })()}</span>
            </div>
            <div className="world-clock-place">
              <span>{clock.label}</span>
              <small className={clock.is_today ? "today" : ""}>{localizedClockDate(clock.date, locale)} · {clock.offset_label}</small>
            </div>
            <button
              className="world-clock-remove"
              onClick={() => void removeClock(clock.timezone).catch((failure) => setError(String(failure)))}
              title={t("worldClock.remove")}
            >
              ×
            </button>
          </div>
        ))}
        {clocks.length === 0 && (
          <span className="world-clock-empty">{t("worldClock.start")}</span>
        )}
      </div>
      {error && <p className="date-format-error" role="alert">{error}</p>}
    </section>
  );
}
