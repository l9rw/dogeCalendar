import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  getCalendarMeta,
  dateKey,
  fetchHolidayYear,
  getHolidayYearInfo,
  getCachedHolidayYears,
  getNextHolidayChange,
  getHolidayCountdown,
  cancelHolidayRequests,
  fetchConfig,
} from "./calendarData.ts";

const CACHE_KEY = "dogecalendar.holidays.v1";

function makeStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
  };
}

let savedFetch;
let savedLocalStorage;
let originalConfig;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  savedLocalStorage = globalThis.localStorage;
  originalConfig = { ...fetchConfig };
  globalThis.localStorage = makeStorage();
  globalThis.localStorage.removeItem(CACHE_KEY);
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = savedLocalStorage;
  Object.assign(fetchConfig, originalConfig);
});

test("lunar spring festival 2026 shows 春节 label and confirmed rest status", () => {
  const meta = getCalendarMeta(new Date(2026, 1, 17));
  assert.equal(meta.lunar, "正月初一");
  assert.equal(meta.lunarDay, "初一");
  assert.equal(meta.holiday, "春节");
  assert.equal(meta.holidayStatus, "rest");
  assert.equal(meta.holidayType, "rest");
});

test("festival label and rest arrangement are strictly separated", () => {
  // 妇女节 is a festival label but never a legal rest/workday arrangement.
  const meta = getCalendarMeta(new Date(2026, 2, 8));
  assert.equal(meta.holiday, "妇女节");
  assert.equal(meta.holidayStatus, undefined);
});

test("lunar cross-year: last day of 2026 maps to 腊月 before spring festival", () => {
  const meta = getCalendarMeta(new Date(2026, 1, 16));
  assert.equal(meta.lunar, "腊月廿九");
  assert.equal(meta.lunarDay, "廿九");
  assert.equal(meta.holiday, "除夕");
});

test("Qingming festival follows the calculated solar term", () => {
  assert.equal(getCalendarMeta(new Date(2026, 3, 5)).holiday, "清明节");
  assert.equal(getCalendarMeta(new Date(2026, 3, 4)).holiday, undefined);
});

test("leap lunar month is rendered with 闰 prefix and no false festival", () => {
  const meta = getCalendarMeta(new Date(2033, 11, 22));
  assert.equal(meta.lunar, "闰冬月初一");
  assert.equal(meta.lunarDay, "初一");
  assert.equal(meta.holiday, undefined);
});

test("solar terms 小寒 and 大寒 are computed via lunar-typescript", () => {
  const xiaohan = getCalendarMeta(new Date(2026, 0, 5));
  const dahan = getCalendarMeta(new Date(2026, 0, 20));
  const dongzhi = getCalendarMeta(new Date(2026, 11, 22));
  assert.equal(xiaohan.solarTerm, "小寒");
  assert.equal(dahan.solarTerm, "大寒");
  assert.equal(dongzhi.solarTerm, "冬至");
  assert.equal(getCalendarMeta(new Date(2026, 0, 6)).solarTerm, undefined);
});

test("unknown year does not guess a legal rest/workday arrangement", () => {
  const info = getHolidayYearInfo(2031);
  assert.equal(info.available, false);
  const meta = getCalendarMeta(new Date(2031, 9, 1));
  assert.equal(meta.holiday, "国庆节");
  assert.equal(meta.holidayStatus, undefined);
  assert.equal(meta.holidayType, "workday");
});

test("built-in year info carries 内置 source and version without fetchedAt", () => {
  const info = getHolidayYearInfo(2026);
  assert.equal(info.available, true);
  assert.equal(info.source, "内置整理数据");
  assert.equal(info.version, "built-in-2007-2026");
  assert.equal(info.fetchedAt, undefined);
});

test("getNextHolidayChange returns next confirmed rest, ignoring plain weekends", () => {
  const holidayYears = {
    2026: {
      "2026-01-01": { name: "元旦", status: "rest" },
      "2026-01-04": { name: "元旦", status: "workday" },
    },
  };
  // 2026-01-02 is a Friday (weekend-adjacent but not in annual data) -> skip.
  const next = getNextHolidayChange(new Date(2026, 0, 2), holidayYears);
  assert.deepEqual(next, { date: "2026-01-04", name: "元旦", status: "workday" });
});

test("getNextHolidayChange returns null when no annual data exists", () => {
  const next = getNextHolidayChange(new Date(2026, 0, 1), {});
  assert.equal(next, null);
});

test("getNextHolidayChange crosses year boundary", () => {
  const holidayYears = {
    2027: { "2027-01-01": { name: "元旦", status: "rest" } },
  };
  const next = getNextHolidayChange(new Date(2026, 11, 31), holidayYears);
  assert.deepEqual(next, { date: "2027-01-01", name: "元旦", status: "rest" });
});

test("holiday countdown finds the next break rather than a makeup workday", () => {
  const years = getCachedHolidayYears();
  assert.deepEqual(getHolidayCountdown(new Date(2026, 8, 19, 23, 59), years), {
    kind: "upcoming", name: "中秋节", date: "2026-09-25", days: 6,
  });
});

test("current holiday counts remaining days including today", () => {
  const years = getCachedHolidayYears();
  assert.deepEqual(getHolidayCountdown(new Date(2026, 9, 4, 23, 59), years), {
    kind: "current", name: "国庆节", date: "2026-10-07", days: 4,
  });
  assert.equal(getHolidayCountdown(new Date(2026, 9, 1), years).days, 7);
  assert.equal(getHolidayCountdown(new Date(2026, 9, 7), years).days, 1);
});

test("ordinary weekends and festival labels do not create a holiday countdown", () => {
  assert.equal(getHolidayCountdown(new Date(2026, 2, 8), { 2026: {} }), null);
  assert.equal(getHolidayCountdown(new Date(NaN), {}), null);
});

test("countdown crosses known years but refuses unknown gaps", () => {
  const years = {
    2026: {},
    2027: { "2027-01-01": { name: "元旦", status: "rest" } },
  };
  assert.deepEqual(getHolidayCountdown(new Date(2026, 11, 31), years), {
    kind: "upcoming", name: "元旦", date: "2027-01-01", days: 1,
  });
  assert.equal(getHolidayCountdown(new Date(2026, 11, 31), { 2027: years[2027] }), null);
  assert.equal(getHolidayCountdown(new Date(2026, 9, 8), getCachedHolidayYears()), null);
});

test("current break joins consecutive rest days across names and years", () => {
  const years = {
    2026: { "2026-12-31": { name: "年末假期", status: "rest" } },
    2027: { "2027-01-01": { name: "元旦", status: "rest" } },
  };
  assert.deepEqual(getHolidayCountdown(new Date(2026, 11, 31), years), {
    kind: "current", name: "年末假期", date: "2027-01-01", days: 2,
  });
  assert.equal(getHolidayCountdown(new Date(2026, 11, 31), { 2026: years[2026] }), null);
});

test("countdown uses civil days across daylight saving transitions", () => {
  const years = { 2026: { "2026-03-09": { name: "测试假期", status: "rest" } } };
  assert.equal(getHolidayCountdown(new Date(2026, 2, 7, 23), years).days, 2);
});

test("dateKey pads month and day", () => {
  assert.equal(dateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(dateKey(new Date(2026, 10, 23)), "2026-11-23");
});

test("fetchHolidayYear returns built-in data synchronously", async () => {
  const data = await fetchHolidayYear(2026);
  assert.ok(data);
  assert.equal(data["2026-01-01"].status, "rest");
  assert.equal(data["2026-10-01"].status, "rest");
});

test("fetchHolidayYear caches remote payload to localStorage and labels non-official source", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        holiday: {
          "2027-01-01": { date: "2027-01-01", name: "元旦", holiday: true },
          "2027-01-04": { date: "2027-01-04", name: "元旦", holiday: false },
        },
      }),
    };
  };
  const data = await fetchHolidayYear(2027);
  assert.equal(calls, 1);
  assert.equal(data["2027-01-01"].status, "rest");
  assert.equal(data["2027-01-04"].status, "workday");

  const info = getHolidayYearInfo(2027);
  assert.equal(info.available, true);
  assert.equal(info.source, "timor.tech（非官方源）");
  assert.equal(info.version, "timor");
  assert.equal(typeof info.fetchedAt, "number");

  const cached = getCachedHolidayYears();
  assert.ok(cached[2027]);
  assert.equal(cached[2027]["2027-01-01"].status, "rest");

  const second = await fetchHolidayYear(2027);
  assert.equal(calls, 1); // cache-first, no second network call
  assert.equal(second["2027-01-01"].status, "rest");
});

test("malformed remote payload returns null without caching", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ holiday: "not-an-object" }) });
  const data = await fetchHolidayYear(2028);
  assert.equal(data, null);
  assert.equal(getHolidayYearInfo(2028).available, false);
  assert.equal(getCachedHolidayYears()[2028], undefined);
});

test("impossible civil dates and empty caches are rejected", async () => {
  globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2041: { year: 2041, data: {}, source: "timor", version: "timor", fetchedAt: Date.now() },
  } }));
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ holiday: {
    bad: { date: "2041-02-30", name: "invalid", holiday: true },
  } }) });
  assert.equal(getHolidayYearInfo(2041).available, false);
  assert.equal(await fetchHolidayYear(2041), null);
});

test("cancellation during retry backoff never starts another request", async () => {
  let calls = 0;
  fetchConfig.backoff = [15];
  fetchConfig.retries = 1;
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  const request = fetchHolidayYear(2042);
  await new Promise((resolve) => setTimeout(resolve, 2));
  cancelHolidayRequests();
  assert.equal(await request, null);
  assert.equal(calls, 1);
});

test("malformed cached entry is ignored and re-fetched", async () => {
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: { 2029: { year: 2029, data: { "2029-13-01": { name: "bad", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: 1 } } }),
  );
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: { "2029-01-01": { date: "2029-01-01", name: "元旦", holiday: true } } }),
  });
  const data = await fetchHolidayYear(2029);
  assert.equal(data["2029-01-01"].status, "rest");
});

test("network failure does not cache null and allows retry", async () => {
  let attempts = 0;
  fetchConfig.retries = 1;
  fetchConfig.backoff = [5, 5];
  fetchConfig.timeout = 50;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new Error("offline");
  };
  const first = await fetchHolidayYear(2030, true);
  assert.equal(first, null);
  assert.equal(getHolidayYearInfo(2030).available, false);
  const second = await fetchHolidayYear(2030, true);
  assert.equal(second, null);
  assert.ok(attempts >= 3); // retried across both calls
});

test("retry with backoff succeeds on later attempt", async () => {
  let attempts = 0;
  fetchConfig.retries = 2;
  fetchConfig.backoff = [5, 5];
  fetchConfig.timeout = 1000;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 2) throw new Error("transient");
    return {
      ok: true,
      status: 200,
      json: async () => ({ holiday: { "2032-01-01": { date: "2032-01-01", name: "元旦", holiday: true } } }),
    };
  };
  const data = await fetchHolidayYear(2032, true);
  assert.equal(attempts, 2);
  assert.equal(data["2032-01-01"].status, "rest");
});

test("concurrent requests are de-duplicated", async () => {
  let calls = 0;
  let resolveResponse;
  globalThis.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveResponse = () =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ holiday: { "2033-01-01": { date: "2033-01-01", name: "元旦", holiday: true } } }),
        });
    });
  };
  const p1 = fetchHolidayYear(2033, true);
  const p2 = fetchHolidayYear(2033, true);
  assert.equal(calls, 1);
  resolveResponse();
  const [d1, d2] = await Promise.all([p1, p2]);
  assert.equal(d1["2033-01-01"].status, "rest");
  assert.equal(d2["2033-01-01"].status, "rest");
  assert.equal(calls, 1);
});

test("network-off falls back to local cache", async () => {
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      schema: 1,
      years: { 2034: { year: 2034, data: { "2034-01-01": { name: "元旦", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: 1700000000000 } },
    }),
  );
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const data = await fetchHolidayYear(2034, true);
  assert.equal(data["2034-01-01"].status, "rest");
});

test("allowNetwork=false returns null without calling fetch when no cache", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ holiday: {} }) };
  };
  const data = await fetchHolidayYear(2035, false);
  assert.equal(data, null);
  assert.equal(calls, 0);
});

test("next-day holiday: getNextHolidayChange finds the immediate next rest day", () => {
  const holidayYears = { 2026: { "2026-02-17": { name: "春节", status: "rest" } } };
  const next = getNextHolidayChange(new Date(2026, 1, 16), holidayYears);
  assert.deepEqual(next, { date: "2026-02-17", name: "春节", status: "rest" });
});

test("stale cache triggers a background refresh when network is allowed", async () => {
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: { 2036: { year: 2036, data: { "2036-01-01": { name: "元旦", status: "workday" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: stale } } }),
  );
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ holiday: { "2036-01-01": { date: "2036-01-01", name: "元旦", holiday: true } } }) };
  };
  const data = await fetchHolidayYear(2036, true);
  assert.equal(calls, 1);
  assert.equal(data["2036-01-01"].status, "rest"); // refreshed value
  assert.ok(getHolidayYearInfo(2036).fetchedAt > stale);
});

test("stale cache is served without a fetch when network is disabled", async () => {
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: { 2037: { year: 2037, data: { "2037-01-01": { name: "元旦", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: stale } } }),
  );
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const data = await fetchHolidayYear(2037, false);
  assert.equal(calls, 0);
  assert.equal(data["2037-01-01"].status, "rest");
});

test("failed refresh falls back to stale cached data instead of null", async () => {
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: { 2038: { year: 2038, data: { "2038-01-01": { name: "元旦", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: stale } } }),
  );
  fetchConfig.retries = 0;
  globalThis.fetch = async () => { throw new Error("offline"); };
  const data = await fetchHolidayYear(2038, true);
  assert.equal(data["2038-01-01"].status, "rest");
});

test("cancelHolidayRequests aborts an in-flight fetch and lets the next call start fresh", async () => {
  fetchConfig.retries = 0;
  fetchConfig.backoff = [5];
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) reject(abortError());
        else signal?.addEventListener("abort", () => reject(abortError()));
      });
    }
    throw new Error("offline");
  };
  const pending = fetchHolidayYear(2039, true);
  cancelHolidayRequests();
  const cancelledData = await pending;
  assert.equal(cancelledData, null);
  const data = await fetchHolidayYear(2039, true);
  assert.equal(data, null);
  assert.ok(calls >= 2);
});

test("getCachedHolidayYears includes built-in years", () => {
  const cached = getCachedHolidayYears();
  assert.ok(cached[2026]);
  assert.equal(cached[2026]["2026-01-01"].status, "rest");
});

test("strict validation: one malformed entry among valid ones rejects the entire year", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      "2030-01-01": { date: "2030-01-01", name: "元旦", holiday: true },
      "2030-01-04": { date: "2030-01-04", name: "元旦", holiday: false },
      bad: { date: "2030-02-30", name: "invalid", holiday: true },
    } }),
  });
  const data = await fetchHolidayYear(2030, true);
  assert.equal(data, null);
  assert.equal(getHolidayYearInfo(2030).available, false);
  assert.equal(getCachedHolidayYears()[2030], undefined);
});

test("strict validation: duplicate dates in payload are rejected", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      a: { date: "2031-01-01", name: "元旦", holiday: true },
      b: { date: "2031-01-01", name: "元旦", holiday: true },
    } }),
  });
  const data = await fetchHolidayYear(2031, true);
  assert.equal(data, null);
  assert.equal(getCachedHolidayYears()[2031], undefined);
});

test("strict validation: non-boolean holiday flag rejects the year", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      "2032-01-01": { date: "2032-01-01", name: "元旦", holiday: "yes" },
    } }),
  });
  const data = await fetchHolidayYear(2032, true);
  assert.equal(data, null);
});

test("strict validation: empty name rejects the year", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      "2033-01-01": { date: "2033-01-01", name: "  ", holiday: true },
    } }),
  });
  const data = await fetchHolidayYear(2033, true);
  assert.equal(data, null);
});

test("strict validation: entry from a different year rejects the payload", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      "2034-01-01": { date: "2034-01-01", name: "元旦", holiday: true },
      "2034-12-31": { date: "2035-01-01", name: "跨年", holiday: true },
    } }),
  });
  const data = await fetchHolidayYear(2034, true);
  assert.equal(data, null);
});

test("strict validation: non-object entry rejects the year", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: {
      "2035-01-01": { date: "2035-01-01", name: "元旦", holiday: true },
      bad: "not-an-object",
    } }),
  });
  const data = await fetchHolidayYear(2035, true);
  assert.equal(data, null);
});

test("getHolidayYearInfo: built-in year carries expired=false and builtIn=true", () => {
  const info = getHolidayYearInfo(2026);
  assert.equal(info.available, true);
  assert.equal(info.builtIn, true);
  assert.equal(info.expired, false);
  assert.equal(info.fetchedAt, undefined);
});

test("getHolidayYearInfo: cached remote year carries expired flag and builtIn=false", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ holiday: { "2036-01-01": { date: "2036-01-01", name: "元旦", holiday: true } } }),
  });
  await fetchHolidayYear(2036, true);
  const fresh = getHolidayYearInfo(2036);
  assert.equal(fresh.available, true);
  assert.equal(fresh.builtIn, false);
  assert.equal(fresh.expired, false);
  assert.equal(typeof fresh.fetchedAt, "number");

  // Simulate staleness by writing an old fetchedAt into the cache.
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: { 2036: { year: 2036, data: { "2036-01-01": { name: "元旦", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: stale } } }),
  );
  const staleInfo = getHolidayYearInfo(2036);
  assert.equal(staleInfo.expired, true);
  assert.equal(staleInfo.builtIn, false);
});

test("getHolidayYearInfo: unknown year has builtIn=false and no expired flag", () => {
  const info = getHolidayYearInfo(2099);
  assert.equal(info.available, false);
  assert.equal(info.builtIn, false);
  assert.equal(info.expired, undefined);
});

test("getCachedHolidayYears: built-in priority — cached remote does not overwrite built-in", async () => {
  // Seed a cached remote entry for 2026 (a built-in year) with different data.
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: {
      2026: { year: 2026, data: { "2026-01-01": { name: "远程元旦", status: "workday" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: Date.now() },
    } }),
  );
  const cached = getCachedHolidayYears();
  // Built-in data must win: 2026-01-01 is "rest" in built-in, not "workday".
  assert.equal(cached[2026]["2026-01-01"].status, "rest");
  assert.equal(cached[2026]["2026-01-01"].name, "元旦");
});

test("getCachedHolidayYears: remote cached year appears when not built-in", async () => {
  globalThis.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ schema: 1, years: {
      2037: { year: 2037, data: { "2037-01-01": { name: "元旦", status: "rest" } }, source: "timor.tech（非官方源）", version: "timor", fetchedAt: Date.now() },
    } }),
  );
  const cached = getCachedHolidayYears();
  assert.ok(cached[2037]);
  assert.equal(cached[2037]["2037-01-01"].status, "rest");
});
