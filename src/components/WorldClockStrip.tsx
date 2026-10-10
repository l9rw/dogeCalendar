import { useEffect, useRef, useState } from "react";
import { useInfoStore } from "../stores/infoStore";
import type { City } from "../services/ipc";
import { useSettingsStore } from "../stores/settingsStore";
import { translator } from "../data/i18n";
import { relativeOffsetMinutes, localizedClockDate, isClockDaytime } from "../services/worldClock";

function ClockSky({ daytime }: { daytime: boolean }) {
  return (
    <svg className="world-clock-sky" viewBox="0 0 64 48" aria-hidden="true">
      {daytime ? <g className="clock-sun">
        <circle cx="32" cy="24" r="9" fill="currentColor" />
        <path d="M32 7v4m0 26v4M15 24h4m26 0h4M20 12l3 3m18 18 3 3M20 36l3-3m18-18 3-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </g> : <>
        <path className="clock-moon" d="M37 8a17 17 0 1 0 14 25A17 17 0 0 1 37 8Z" fill="currentColor" />
        <g className="clock-stars" fill="currentColor"><circle cx="48" cy="10" r="1.5" /><circle cx="55" cy="23" r="1" /><circle cx="15" cy="9" r="1" /></g>
      </>}
    </svg>
  );
}

export function WorldClockStrip() {
  const language = useSettingsStore((state) => state.language);
  const { t, inChinese } = translator(language);
  const [localNow, setLocalNow] = useState(() => new Date());
  const [error, setError] = useState("");
  const locale = inChinese ? "zh-CN" : "en-US";
  const clocks = useInfoStore((state) => state.clocks);
  const localClock = useInfoStore((state) => state.localClock);
  const searching = useInfoStore((state) => state.searching);
  const use24Hour = useInfoStore((state) => state.use24Hour);
  const loadClocks = useInfoStore((state) => state.loadClocks);
  const loadUse24Hour = useInfoStore((state) => state.loadUse24Hour);
  const setUse24Hour = useInfoStore((state) => state.setUse24Hour);
  const removeClock = useInfoStore((state) => state.removeClock);
  const reorderClocks = useInfoStore((state) => state.reorderClocks);
  const addClock = useInfoStore((state) => state.addClock);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFailed, setSearchFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    void Promise.all([loadUse24Hour(), loadClocks()]).catch((failure) => setError(String(failure)));
  }, [loadUse24Hour, loadClocks]);

  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      setHidden(document.hidden);
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
    let cancelled = false;
    setSearchFailed(false);
    const search = useInfoStore.getState().search;
    void search(query).catch(() => { if (!cancelled) setSearchFailed(true); });
    return () => { cancelled = true; };
  }, [pickerOpen, query]);

  const results = useInfoStore((state) => state.searchResults);
  const pinnedTzs = new Set(clocks.map((clock) => clock.timezone));
  const candidates = results.filter((city) => !pinnedTzs.has(city.timezone));
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localTime24 = `${String(localNow.getHours()).padStart(2, "0")}:${String(localNow.getMinutes()).padStart(2, "0")}`;
  const displayedClocks = [{
    label: t("worldClock.local"), timezone: "local", time_24: localTime24,
    time_12: localNow.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: true }),
    date: "", offset_label: localTimezone, offset_minutes: -localNow.getTimezoneOffset(),
    is_today: true, is_dst: localClock?.is_dst ?? null,
  }, ...clocks];

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
    <section className="world-clock-strip" aria-label={t("worldTime")} data-paused={hidden}>
      <div className="world-clock-header">
        <span className="world-clock-title">{t("worldTime")}</span>
        <button
          className={`world-clock-format ${use24Hour ? "active" : ""}`}
          onClick={() => void setUse24Hour(!use24Hour).catch((failure) => setError(String(failure)))}
          title={t("worldClock.format")}
          aria-label={t("worldClock.format")}
        >
          {use24Hour ? "24h" : "12h"}
        </button>
        <button
          className="world-clock-add"
          onClick={() => {
            if (!pickerOpen) useInfoStore.setState({ searchResults: [], searching: true });
            setPickerOpen((value) => !value);
          }}
          title={t("worldClock.add")}
          aria-label={t("worldClock.add")}
          aria-expanded={pickerOpen}
          aria-controls="world-clock-picker"
        >
          ＋
        </button>
      </div>

      {pickerOpen && (
        <div className="world-clock-picker" id="world-clock-picker">
          <input
            className="world-clock-search"
            autoFocus
            placeholder={t("worldClock.search")}
            aria-label={t("worldClock.search")}
            value={query}
            onChange={(event) => {
              useInfoStore.setState({ searchResults: [], searching: true });
              setQuery(event.target.value);
            }}
          />
          <div className="world-clock-results" aria-busy={searching}>
            {searching || searchFailed || candidates.length === 0 ? (
              <span className="world-clock-empty" role="status">{t(searching ? "worldClock.searching" : searchFailed ? "worldClock.searchFailed" : "worldClock.empty")}</span>
            ) : (
              candidates.map((city: City) => (
                <button
                  key={`${city.timezone}:${city.label}`}
                  className="world-clock-result"
                  disabled={adding}
                  onClick={() => {
                    setAdding(true);
                    setError("");
                    void addClock(city).then(() => {
                      setPickerOpen(false);
                      setQuery("");
                    }).catch((failure) => setError(String(failure))).finally(() => setAdding(false));
                  }}
                >
                  <span>{city.label}{city.country && <small>{city.country}</small>}</span>
                  <small>{city.timezone}</small>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className="world-clock-list">
        {displayedClocks.map((clock, index) => {
          const isLocal = clock.timezone === "local";
          const daytime = isClockDaytime(clock.time_24);
          return (
          <div
            key={clock.timezone}
            className={`world-clock-item ${isLocal ? "local-clock" : ""}`}
            data-daytime={daytime}
            draggable={!isLocal}
            onDragStart={() => { if (!isLocal) onDragStart(index - 1); }}
            onDragOver={(event) => { if (!isLocal) onDragOver(event, index - 1); }}
            onDrop={(event) => event.preventDefault()}
            onDragEnd={onDragEnd}
          >
            <div className="world-clock-place"><span title={clock.label}>{clock.label}</span></div>
            <ClockSky daytime={daytime} />
            <div className="world-clock-time">
              <strong>{use24Hour ? clock.time_24 : clock.time_12}</strong>
            </div>
            <div className="world-clock-date">{isLocal ? localNow.toLocaleDateString(locale, { month: "short", day: "numeric", weekday: "short" }) : localizedClockDate(clock.date, locale)}</div>
            <div className="world-clock-offset" title={isLocal ? localTimezone : `${clock.timezone} · ${t("worldClock.relative")}`}>
              {isLocal ? localTimezone.replaceAll("_", " ") : `${clock.offset_label} · ${(() => {
                const delta = relativeOffsetMinutes(clock.offset_minutes, localNow.getTimezoneOffset());
                if (!delta) return t("worldClock.same");
                const absolute = Math.abs(delta);
                return `${t(delta > 0 ? "worldClock.ahead" : "worldClock.behind")} ${Math.floor(absolute / 60)} ${t("worldClock.hours")}${absolute % 60 ? ` ${absolute % 60} ${t("worldClock.minutes")}` : ""}`;
              })()}`}
            </div>
            <div className="world-clock-status">
              <span title={t("worldClock.dayHint")}>{t(daytime ? "worldClock.day" : "worldClock.night")}</span>
              <span className={clock.is_dst ? "is-dst" : ""}>{t(clock.is_dst === null ? "worldClock.dstUnknown" : clock.is_dst ? "worldClock.dst" : "worldClock.standard")}</span>
            </div>
            {!isLocal && <button
              className="world-clock-remove"
              onClick={() => void removeClock(clock.timezone).catch((failure) => setError(String(failure)))}
              title={t("worldClock.remove")}
              aria-label={`${t("worldClock.remove")} ${clock.label}`}
            >
              ×
            </button>}
          </div>
        ); })}
        {clocks.length === 0 && (
          <span className="world-clock-empty">{t("worldClock.start")}</span>
        )}
      </div>
      {error && <p className="date-format-error" role="alert">{error}</p>}
    </section>
  );
}
