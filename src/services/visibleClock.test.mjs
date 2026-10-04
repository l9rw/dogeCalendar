import assert from "node:assert/strict";
import test from "node:test";
import { startVisibleClock } from "./visibleClock.ts";

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(isVisible = () => true) {
  const timers = new Map();
  const dates = [];
  const errors = [];
  let time = new Date(2026, 9, 4, 14, 45, 12, 250).getTime();
  let id = 0;
  const clock = startVisibleClock({
    isVisible,
    update: (date) => dates.push(date),
    now: () => new Date(time),
    schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    cancel: (timer) => timers.delete(timer),
    onError: (error) => errors.push(error),
  });
  return { clock, dates, timers, errors, setTime: (value) => { time = value; } };
}

test("visible clock updates immediately and schedules at the next second", async () => {
  const f = fixture();
  await settle();
  assert.equal(f.dates.length, 1);
  const [id, timer] = [...f.timers][0];
  assert.equal(timer.delay, 750);
  f.setTime(f.dates[0].getTime() + 750);
  f.timers.delete(id);
  timer.callback();
  await settle();
  assert.equal(f.dates[1].getSeconds(), 13);
  assert.equal([...f.timers.values()][0].delay, 1000);
  f.clock.dispose();
  assert.equal(f.timers.size, 0);
});

test("hidden clock pauses and reopening immediately reads current time", async () => {
  let visible = false;
  const f = fixture(() => visible);
  await settle();
  assert.equal(f.timers.size, 0);
  assert.equal(f.dates.length, 0);
  visible = true;
  const reopened = new Date(2026, 9, 4, 15, 7, 42, 0).getTime();
  f.setTime(reopened);
  await f.clock.refresh();
  assert.equal(f.dates[0].getTime(), reopened);
  assert.equal(f.timers.size, 1);
  visible = false;
  await f.clock.refresh();
  assert.equal(f.timers.size, 0);
  assert.equal(f.dates.length, 1);
  f.clock.dispose();
});

test("native visibility is authoritative even if WebView reports hidden", async () => {
  const page = { hidden: true };
  const native = { isVisible: async () => true };
  const f = fixture(() => native.isVisible());
  await settle();
  assert.equal(page.hidden, true);
  assert.equal(f.dates.length, 1);
  assert.equal(f.timers.size, 1);
  f.clock.dispose();
});

test("out-of-order visibility responses cannot restart a hidden clock", async () => {
  const queries = [];
  const f = fixture(() => new Promise((resolve) => queries.push(resolve)));
  const pending = f.clock.refresh();
  queries[1](false);
  await pending;
  queries[0](true);
  await settle();
  assert.equal(f.dates.length, 0);
  assert.equal(f.timers.size, 0);
  f.clock.dispose();
});

test("disposing during an in-flight visibility query prevents updates", async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  f.clock.dispose();
  resolve(true);
  await settle();
  await f.clock.refresh();
  assert.equal(f.dates.length, 0);
  assert.equal(f.timers.size, 0);
});

test("visibility query errors are handled without unhandled rejection", async () => {
  const f = fixture(async () => { throw new Error("IPC unavailable"); });
  await settle();
  assert.equal(f.errors.length, 1);
  assert.equal(f.timers.size, 0);
  f.clock.dispose();
});
