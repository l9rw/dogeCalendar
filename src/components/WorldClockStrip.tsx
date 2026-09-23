import { useEffect, useRef, useState } from "react";
import { useInfoStore } from "../stores/infoStore";
import type { City } from "../services/ipc";

export function WorldClockStrip() {
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
    loadUse24Hour();
    loadClocks();
  }, [loadUse24Hour, loadClocks]);

  useEffect(() => {
    if (!pickerOpen) return;
    const search = useInfoStore.getState().search;
    search(query);
  }, [pickerOpen, query]);

  const results = useInfoStore((state) => state.searchResults);
  const pinnedTzs = new Set(clocks.map((clock) => clock.timezone));
  const candidates = results.filter((city) => !pinnedTzs.has(city.timezone)).slice(0, 8);

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
    reorderClocks(clocks.map((clock) => clock.timezone));
    dragIndex.current = null;
  };

  return (
    <section className="world-clock-strip" aria-label="世界时间">
      <div className="world-clock-header">
        <span className="world-clock-title">世界时间</span>
        <button
          className={`world-clock-format ${use24Hour ? "active" : ""}`}
          onClick={() => setUse24Hour(!use24Hour)}
          title="切换 12/24 小时制"
        >
          {use24Hour ? "24h" : "12h"}
        </button>
        <button
          className="world-clock-add"
          onClick={() => setPickerOpen((value) => !value)}
          title="添加城市"
        >
          ＋
        </button>
      </div>

      {pickerOpen && (
        <div className="world-clock-picker">
          <input
            className="world-clock-search"
            autoFocus
            placeholder="搜索城市或时区"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="world-clock-results">
            {candidates.length === 0 ? (
              <span className="world-clock-empty">未找到匹配的城市</span>
            ) : (
              candidates.map((city: City) => (
                <button
                  key={city.timezone}
                  className="world-clock-result"
                  onClick={() => {
                    addClock(city);
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
              <span>{clock.offset_label}</span>
            </div>
            <div className="world-clock-place">
              <span>{clock.label}</span>
              <small className={clock.is_today ? "today" : ""}>{clock.weekday}</small>
            </div>
            <button
              className="world-clock-remove"
              onClick={() => removeClock(clock.timezone)}
              title="移除"
            >
              ×
            </button>
          </div>
        ))}
        {clocks.length === 0 && (
          <span className="world-clock-empty">点击 ＋ 添加城市</span>
        )}
      </div>
    </section>
  );
}
