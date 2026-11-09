import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, beforeEach, afterEach } from "node:test";
import { translator } from "../data/i18n.ts";
let {
  getCalendarMeta,
  dateKey,
  fetchHolidayYear,
  getHolidayYearInfo,
  getCachedHolidayYears,
  getNextHolidayChange,
  getHolidayCountdown,
  cancelHolidayRequests,
  fetchConfig,
} = await import("./calendarData.ts");

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
let mockClock;
let moduleVersion = 0;

beforeEach(async (context) => {
  ({ getCalendarMeta, dateKey, fetchHolidayYear, getHolidayYearInfo, getCachedHolidayYears,
    getNextHolidayChange, getHolidayCountdown, cancelHolidayRequests, fetchConfig,
  } = await import(`./calendarData.ts?test=${++moduleVersion}`));
  mockClock = context.mock.timers;
  mockClock.enable({ apis: ["Date"], now: new Date(2027, 10, 9, 12).getTime() });
  savedFetch = globalThis.fetch;
  savedLocalStorage = globalThis.localStorage;
  originalConfig = { ...fetchConfig };
  globalThis.localStorage = makeStorage();
  globalThis.localStorage.removeItem(CACHE_KEY);
});

afterEach(() => {
  cancelHolidayRequests();
  globalThis.fetch = savedFetch;
  if (savedLocalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = savedLocalStorage;
  Object.assign(fetchConfig, originalConfig);
});

function setRequestDate(year, month = 10, day = 9) {
  mockClock.setTime(new Date(year - 1, month, day, 12).getTime());
}

const primaryPayload = (year, name = "元旦") => ({ code: 0, holiday: {
  a: { date: `${year}-01-01`, name, holiday: true },
} });

test("online requests start at local November 1 and never target the current, past or third year", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => primaryPayload(Number(url.split("/").at(-1))) };
  };
  mockClock.setTime(new Date(2026, 10, 1, 0).getTime());
  assert.equal(await fetchHolidayYear(2028), null);
  setRequestDate(2028, 9, 31);
  assert.equal(await fetchHolidayYear(2028), null);
  setRequestDate(2028, 10, 1);
  assert.equal(await fetchHolidayYear(2029), null);
  assert.equal(await fetchHolidayYear(2030), null);
  assert.equal(urls.length, 0);
  assert.equal((await fetchHolidayYear(2028))["2028-01-01"].status, "rest");
  assert.equal(urls.length, 1);
  assert.equal(await fetchHolidayYear(2028.5), null);
  assert.equal(await fetchHolidayYear(2101), null);
  mockClock.setTime(new Date(2028, 10, 1, 12).getTime());
  await fetchHolidayYear(2028); // now a historical target for online polling
  assert.equal(urls.length, 1);
});

test("successful data refreshes the next local day even within the old 30-day cache TTL", async () => {
  setRequestDate(2028, 10, 1);
  let calls = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => primaryPayload(2028, `updated-${++calls}`) });
  assert.equal((await fetchHolidayYear(2028))["2028-01-01"].name, "updated-1");
  assert.equal((await fetchHolidayYear(2028))["2028-01-01"].name, "updated-1");
  setRequestDate(2028, 10, 2);
  assert.equal((await fetchHolidayYear(2028))["2028-01-01"].name, "updated-2");
  assert.equal((await fetchHolidayYear(2028))["2028-01-01"].name, "updated-2");
  assert.equal(calls, 2);
});

test("daily network retry budget survives module reload and resets on a new local day", async () => {
  setRequestDate(2028, 10, 1);
  fetchConfig.retries = 0;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], { day: "2027-11-01", attempts: 1, done: false });
  const restarted = await import(`./calendarData.ts?restart=${++moduleVersion}`);
  restarted.fetchConfig.retries = 0;
  assert.equal(await restarted.fetchHolidayYear(2028), null);
  assert.equal(calls, 2);
  setRequestDate(2028, 10, 2);
  assert.equal(await restarted.fetchHolidayYear(2028), null);
  assert.equal(calls, 4);
  setRequestDate(2028, 10, 1); // clock rollback cannot repeat the old day
  assert.equal(await restarted.fetchHolidayYear(2028), null);
  assert.equal(calls, 4);
});

test("default retry budget is one initial round plus three retries per local day", async () => {
  fetchConfig.backoff = [1];
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); throw new Error("offline"); };
  assert.equal(fetchConfig.retries, 3);
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(urls.length, 8); // four rounds, two sources at most per round
  assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], {
    day: "2027-11-09", attempts: 4, done: false,
  });
  assert.equal(getHolidayYearInfo(2028).available, false);
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(urls.length, 8);
  const restarted = await import(`./calendarData.ts?restart=${++moduleVersion}`);
  assert.equal(await restarted.fetchHolidayYear(2028), null);
  assert.equal(urls.length, 8);
});

test("successful fallback counts as today's success even after the primary network fails", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes("timor.tech")) throw new Error("network");
    return { ok: true, status: 200, json: async () => ({
      year: 2028, papers: ["https://www.gov.cn/"],
      days: [{ date: "2028-01-01", name: "元旦", isOffDay: true }],
    }) };
  };
  const data = await fetchHolidayYear(2028);
  assert.ok(data);
  assert.equal(urls.length, 2);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].done, true);
  const restarted = await import(`./calendarData.ts?restart=${++moduleVersion}`);
  assert.deepEqual(await restarted.fetchHolidayYear(2028), data);
  assert.equal(urls.length, 2);
});

test("cancelled partial retry budget survives reload and can still succeed that day", async () => {
  fetchConfig.backoff = [30];
  let calls = 0;
  let fallbackStarted;
  const fallbackReady = new Promise((resolve) => { fallbackStarted = resolve; });
  globalThis.fetch = async (url) => {
    calls++;
    if (url.includes("jsdelivr")) fallbackStarted();
    throw new Error("offline");
  };
  const pending = fetchHolidayYear(2028);
  await fallbackReady;
  await new Promise((resolve) => setImmediate(resolve));
  cancelHolidayRequests();
  assert.equal(await pending, null);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].attempts, 1);
  const restarted = await import(`./calendarData.ts?restart=${++moduleVersion}`);
  restarted.fetchConfig.backoff = [1];
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => primaryPayload(2028) };
  };
  const data = await restarted.fetchHolidayYear(2028);
  assert.ok(data);
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], {
    day: "2027-11-09", attempts: 2, done: true,
  });
  assert.deepEqual(await restarted.fetchHolidayYear(2028), data);
  assert.equal(calls, 3);
});

test("serving stale cached data after network failure does not count as a successful refresh", async () => {
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  const data = { "2028-01-01": { name: "元旦", status: "rest" } };
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2028: { year: 2028, data, source: "timor", version: "timor", fetchedAt: stale },
  } }));
  fetchConfig.backoff = [1];
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  assert.deepEqual(await fetchHolidayYear(2028), data);
  assert.equal(calls, 8);
  assert.equal(getHolidayYearInfo(2028).fetchedAt, stale);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].done, false);
  assert.deepEqual(await fetchHolidayYear(2028), data);
  assert.equal(calls, 8);
});

test("empty data and HTTP 4xx do not start a network retry loop", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return url.includes("timor.tech")
      ? { ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) }
      : { ok: false, status: 404 };
  };
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(getHolidayYearInfo(2028).available, false);
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(calls, 2);
  setRequestDate(2028, 10, 10);
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(calls, 4);
});

test("network retries stop at local midnight and resume with a fresh budget on the next call", async () => {
  mockClock.setTime(new Date(2027, 10, 1, 23, 59, 59).getTime());
  fetchConfig.backoff = [1];
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (url.includes("jsdelivr")) mockClock.setTime(new Date(2027, 10, 2, 0, 0, 1).getTime());
    throw new Error("offline");
  };
  assert.equal(await fetchHolidayYear(2028), null);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].day, "2027-11-01");
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => primaryPayload(2028) }; };
  assert.ok(await fetchHolidayYear(2028));
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], {
    day: "2027-11-02", attempts: 1, done: true,
  });
});

test("a cancelled older request cannot overwrite the success of its replacement", async () => {
  let completeOldBody;
  let bodyStarted;
  const ready = new Promise((resolve) => { bodyStarted = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls > 1) return { ok: true, status: 200, json: async () => primaryPayload(2028, "new") };
    return { ok: true, status: 200, json: () => new Promise((resolve) => {
      completeOldBody = () => resolve(primaryPayload(2028, "old"));
      bodyStarted();
    }) };
  };
  const old = fetchHolidayYear(2028);
  await ready;
  cancelHolidayRequests();
  fetchConfig.backoff = [1];
  const replacement = await fetchHolidayYear(2028);
  assert.equal(replacement["2028-01-01"].name, "new");
  completeOldBody();
  assert.equal(await old, null);
  assert.equal(getCachedHolidayYears()[2028]["2028-01-01"].name, "new");
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].done, true);
  assert.equal(calls, 2);
});

for (const failure of ["timeout", "server", "body"]) {
  test(`${failure} failures can recover on the third and final daily retry`, async () => {
    fetchConfig.backoff = [1];
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (url.includes("timor.tech")) return { ok: false, status: 404 };
      if (calls < 8) {
        if (failure === "server") return { ok: false, status: 503 };
        if (failure === "body") return { ok: true, status: 200, json: async () => { throw new TypeError("connection reset"); } };
        throw Object.assign(new Error("timeout"), { name: "AbortError" });
      }
      return { ok: true, status: 200, json: async () => ({
        year: 2028, papers: ["https://www.gov.cn/"],
        days: [{ date: "2028-01-01", name: "元旦", isOffDay: true }],
      }) };
    };
    const data = await fetchHolidayYear(2028);
    assert.ok(data);
    assert.equal(calls, 8);
    assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], {
      day: "2027-11-09", attempts: 4, done: true,
    });
    assert.deepEqual(await fetchHolidayYear(2028), data);
    assert.equal(calls, 8);
  });
}

test("turning networking off does not spend the daily quota or join an in-flight request", async () => {
  assert.equal(await fetchHolidayYear(2028, false), null);
  assert.equal(localStorage.getItem(CACHE_KEY), null);
  let respond;
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return new Promise((resolve) => { respond = resolve; });
  };
  const online = fetchHolidayYear(2028);
  assert.equal(await fetchHolidayYear(2028, false), null);
  respond({ ok: true, status: 200, json: async () => primaryPayload(2028) });
  assert.ok(await online);
  assert.equal(calls, 1);
});

test("new year stops polling last year's target until November opens the next one", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => primaryPayload(Number(url.split("/").at(-1))) };
  };
  setRequestDate(2028, 11, 31);
  const known = await fetchHolidayYear(2028);
  mockClock.setTime(new Date(2028, 0, 1, 12).getTime());
  assert.deepEqual(await fetchHolidayYear(2028), known);
  assert.equal(await fetchHolidayYear(2029), null);
  setRequestDate(2029, 9, 31);
  assert.equal(await fetchHolidayYear(2029), null);
  assert.equal(urls.length, 1);
  setRequestDate(2029, 10, 1);
  assert.ok(await fetchHolidayYear(2029));
  assert.equal(urls.length, 2);
});

test("out-of-window calls still read cached data without touching the network or daily quota", async () => {
  const data = { "2028-01-01": { name: "元旦", status: "rest" } };
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2028: { year: 2028, data, source: "timor", version: "timor", fetchedAt: 1 },
  } }));
  setRequestDate(2028, 9, 31);
  globalThis.fetch = async () => { assert.fail("must stay offline"); };
  assert.deepEqual(await fetchHolidayYear(2028), data);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).attempts, undefined);
});

test("an existing cache fetched today also prevents another round after upgrading", async () => {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2028: { year: 2028, data: { "2028-01-01": { name: "元旦", status: "rest" } }, source: "timor", version: "timor", fetchedAt: Date.now() },
  } }));
  globalThis.fetch = async () => { assert.fail("already fetched today"); };
  assert.ok(await fetchHolidayYear(2028));
});

for (const storageFailure of ["read", "write"]) {
  test(`daily quota works in memory when localStorage ${storageFailure} fails`, async () => {
    const storage = localStorage;
    globalThis.localStorage = {
      getItem: (key) => { if (storageFailure === "read") throw new Error("blocked"); return storage.getItem(key); },
      setItem: () => { throw new Error("blocked"); },
    };
    fetchConfig.retries = 0;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("offline"); };
    assert.equal(await fetchHolidayYear(2028), null);
    assert.equal(await fetchHolidayYear(2028), null);
    assert.equal(calls, 2);
    setRequestDate(2028, 10, 10);
    assert.equal(await fetchHolidayYear(2028), null);
    assert.equal(calls, 4);
  });
}

test("malformed request history is ignored without losing valid cached data", async () => {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, requests: { 2028: { day: "not-a-date", attempts: "bad", done: false } }, years: {} }));
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => primaryPayload(2028) });
  assert.ok(await fetchHolidayYear(2028));
  assert.deepEqual(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028], { day: "2027-11-09", attempts: 1, done: true });
});

test("a request finishing after midnight counts against its starting day", async () => {
  mockClock.setTime(new Date(2027, 10, 1, 23, 59, 59).getTime());
  let respond;
  globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
  const pending = fetchHolidayYear(2028);
  mockClock.setTime(new Date(2027, 10, 2, 0, 0, 1).getTime());
  respond({ ok: true, status: 200, json: async () => primaryPayload(2028) });
  assert.ok(await pending);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].day, "2027-11-01");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => primaryPayload(2028) }; };
  assert.ok(await fetchHolidayYear(2028));
  assert.equal(calls, 1);
  assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].day, "2027-11-02");
});

test("request window and daily history use local dates rather than UTC", async () => {
  const saved = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    mockClock.setTime(new Date(2027, 10, 1, 0, 1).getTime());
    assert.equal(new Date().toISOString().slice(0, 10), "2027-10-31");
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => primaryPayload(2028) }; };
    assert.ok(await fetchHolidayYear(2028));
    assert.equal(JSON.parse(localStorage.getItem(CACHE_KEY)).requests[2028].day, "2027-11-01");
    mockClock.setTime(new Date(2027, 10, 1, 23, 59).getTime());
    assert.ok(await fetchHolidayYear(2028));
    assert.equal(calls, 1);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
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
  assert.equal(info.version, "built-in-2007-2027");
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
  assert.equal(getHolidayCountdown(new Date(2026, 9, 8), { 2026: getCachedHolidayYears()[2026] }), null);
  assert.deepEqual(getHolidayCountdown(new Date(2026, 9, 8), getCachedHolidayYears()), {
    kind: "upcoming", name: "元旦", date: "2027-01-01", days: 85,
  });
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

test("2027 arrangements from the published notice work offline and override old remote data", async () => {
  globalThis.localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2027: { year: 2027, data: { "2027-01-01": { name: "old", status: "workday" } }, source: "timor", version: "timor", fetchedAt: Date.now() },
  } }));
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  const data = await fetchHolidayYear(2027, false);
  assert.deepEqual(await fetchHolidayYear(2027, true), data);
  assert.equal(calls, 0);
  // 国办发明电〔2026〕10号: 29 rest days and 5 adjusted workdays.
  const expected = {};
  for (const [name, month, rest, work] of [
    ["元旦", "01", [1, 2, 3], []],
    ["春节", "01", [], [31]],
    ["春节", "02", [5, 6, 7, 8, 9, 10, 11, 12, 13], [14]],
    ["清明节", "04", [3, 4, 5], []],
    ["劳动节", "05", [1, 2, 3, 4, 5], [8]],
    ["端午节", "06", [9], []],
    ["中秋节", "09", [15], []],
    ["国庆节", "09", [], [26]],
    ["国庆节", "10", [1, 2, 3, 4, 5, 6, 7], [9]],
  ]) {
    for (const day of rest) expected[`2027-${month}-${String(day).padStart(2, "0")}`] = { name, status: "rest" };
    for (const day of work) expected[`2027-${month}-${String(day).padStart(2, "0")}`] = { name, status: "workday" };
  }
  assert.deepEqual(data, expected);
  assert.deepEqual(getCachedHolidayYears()[2027], expected);
  assert.equal(getHolidayYearInfo(2027).builtIn, true);
  assert.equal(getCalendarMeta(new Date(2027, 0, 31)).holidayStatus, "workday");
  assert.equal(getCalendarMeta(new Date(2027, 1, 13)).holidayStatus, "rest");
  assert.equal(getCalendarMeta(new Date(2027, 0, 4)).holidayStatus, undefined);
  assert.deepEqual(getHolidayCountdown(new Date(2026, 10, 9), getCachedHolidayYears()), {
    kind: "upcoming", name: "元旦", date: "2027-01-01", days: 53,
  });
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
          "2028-01-01": { date: "2028-01-01", name: "元旦", holiday: true },
          "2028-01-04": { date: "2028-01-04", name: "元旦", holiday: false },
        },
      }),
    };
  };
  const data = await fetchHolidayYear(2028);
  assert.equal(calls, 1);
  assert.equal(data["2028-01-01"].status, "rest");
  assert.equal(data["2028-01-04"].status, "workday");

  const info = getHolidayYearInfo(2028);
  assert.equal(info.available, true);
  assert.equal(info.source, "timor.tech（非官方源）");
  assert.equal(info.version, "timor");
  assert.equal(typeof info.fetchedAt, "number");

  const cached = getCachedHolidayYears();
  assert.ok(cached[2028]);
  assert.equal(cached[2028]["2028-01-01"].status, "rest");

  const second = await fetchHolidayYear(2028);
  assert.equal(calls, 1); // today's quota is already spent
  assert.equal(second["2028-01-01"].status, "rest");
});

const holidayCnPayload = (year, days = [{ date: `${year}-01-01`, name: "元旦", isOffDay: true }]) => ({
  year,
  papers: ["https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm"],
  days,
});

test("empty primary data falls back to holiday-cn and caches its source and workday mapping", async () => {
  const urls = [];
  const expected = {
    "2028-01-01": { name: "元旦", status: "rest" },
    "2028-01-04": { name: "元旦", status: "workday" },
  };
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes("timor.tech")) return { ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) };
    return { ok: true, status: 200, json: async () => holidayCnPayload(2028, [
      { date: "2028-01-01", name: " 元旦 ", isOffDay: true },
      { date: "2028-01-04", name: "元旦", isOffDay: false },
    ]) };
  };
  assert.deepEqual(await fetchHolidayYear(2028), expected);
  assert.deepEqual(urls, [
    "https://timor.tech/api/holiday/year/2028",
    "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2028.json",
  ]);
  const info = getHolidayYearInfo(2028);
  assert.equal(info.source, "holiday-cn（非官方源，经 jsDelivr）");
  assert.equal(info.version, "holiday-cn");
  assert.equal(info.builtIn, false);
  assert.equal(info.expired, false);
  assert.deepEqual(await fetchHolidayYear(2028), expected);
  assert.deepEqual(await fetchHolidayYear(2028, false), expected);
  assert.equal(urls.length, 2);
});

for (const failure of ["network", "timeout", "body timeout", "http 404", "http 500", "invalid JSON", "invalid payload", "API error"]) {
  test(`fallback handles primary ${failure}`, async () => {
    localStorage.clear();
    setRequestDate(2040);
    fetchConfig.retries = 0;
    const urls = [];
    const abortError = () => Object.assign(new Error("timeout"), { name: "AbortError" });
    globalThis.fetch = async (url) => {
      urls.push(url);
      if (url.includes("timor.tech")) {
        if (failure === "network") throw new Error("offline");
        if (failure === "timeout") throw abortError();
        if (failure.startsWith("http")) return { ok: false, status: Number(failure.slice(5)) };
        if (failure === "body timeout") return { ok: true, status: 200, json: async () => { throw abortError(); } };
        if (failure === "invalid JSON") return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } };
        if (failure === "API error") return { ok: true, status: 200, json: async () => ({ code: -1, holiday: {
          a: { date: "2040-01-02", name: "invalid", holiday: true },
        } }) };
        return { ok: true, status: 200, json: async () => ({ holiday: "invalid" }) };
      }
      const year = Number(url.match(/(\d{4})\.json$/)[1]);
      return { ok: true, status: 200, json: async () => holidayCnPayload(year) };
    };
    const data = await fetchHolidayYear(2040);
    assert.deepEqual(data, { "2040-01-01": { name: "元旦", status: "rest" } });
    assert.equal(urls.length, 2);
    assert.equal(getHolidayYearInfo(2040).version, "holiday-cn");
  });
}

test("fallback retries transient failures without retrying an empty primary payload", async () => {
  setRequestDate(2040);
  const urls = [];
  let fallbackCalls = 0;
  fetchConfig.backoff = [1];
  fetchConfig.retries = 1;
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes("timor.tech")) return { ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) };
    if (++fallbackCalls === 1) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => holidayCnPayload(2040) };
  };
  assert.ok(await fetchHolidayYear(2040));
  assert.equal(urls.filter((url) => url.includes("timor.tech")).length, 2);
  assert.equal(fallbackCalls, 2);
});

{
  const valid = holidayCnPayload(2040);
  for (const [name, payload] of [
    ["null", null],
    ["empty days", { ...valid, days: [] }],
    ["wrong year", { ...valid, year: 2041 }],
    ["non-numeric year", { ...valid, year: "2040" }],
    ["missing announcement", { ...valid, papers: [] }],
    ["invalid announcement", { ...valid, papers: [null] }],
    ["empty announcement", { ...valid, papers: ["  "] }],
    ["non-array days", { ...valid, days: {} }],
    ["non-object day", { ...valid, days: [...valid.days, "bad"] }],
    ["impossible date", holidayCnPayload(2040, [...valid.days, { date: "2040-02-30", name: "bad", isOffDay: true }])],
    ["wrong date year", holidayCnPayload(2040, [{ date: "2041-01-01", name: "bad", isOffDay: true }])],
    ["previous non-December date", holidayCnPayload(2040, [{ date: "2039-11-30", name: "bad", isOffDay: true }])],
    ["empty name", holidayCnPayload(2040, [{ date: "2040-01-01", name: " ", isOffDay: true }])],
    ["non-boolean flag", holidayCnPayload(2040, [{ date: "2040-01-01", name: "bad", isOffDay: "true" }])],
    ["duplicate date", holidayCnPayload(2040, [...valid.days, { ...valid.days[0], isOffDay: false }])],
    ["only previous December", holidayCnPayload(2040, [{ date: "2039-12-31", name: "元旦", isOffDay: true }])],
  ]) {
    test(`fallback rejects ${name}`, async () => {
      localStorage.clear();
      setRequestDate(2040);
      globalThis.fetch = async (url) => ({
        ok: true, status: 200,
        json: async () => url.includes("timor.tech") ? { code: 0, holiday: {} } : payload,
      });
      assert.equal(await fetchHolidayYear(2040), null);
      assert.equal(getHolidayYearInfo(2040).available, false);
      assert.equal(getCachedHolidayYears()[2040], undefined);
    });
  }
}

test("fallback reads only the requested announcement and does not probe the third year", async () => {
  setRequestDate(2040);
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200,
      json: async () => url.includes("timor.tech") ? { code: 0, holiday: {} } : holidayCnPayload(2040, [
        { date: "2039-12-31", name: "元旦", isOffDay: true },
        { date: "2040-01-01", name: "元旦", isOffDay: true },
        { date: "2040-12-29", name: "旧安排", isOffDay: false },
      ]),
    };
  };
  const data = await fetchHolidayYear(2040);
  assert.deepEqual(data, {
    "2040-01-01": { name: "元旦", status: "rest" },
    "2040-12-29": { name: "旧安排", status: "workday" },
  });
  assert.deepEqual(await fetchHolidayYear(2040, false), data);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes("2040")));
  assert.equal(getHolidayYearInfo(2041).available, false);
});

test("fallback preserves cached December adjustments without requesting a later announcement", async () => {
  setRequestDate(2040);
  const stale = Date.now() - fetchConfig.cacheTtl - 1000;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ schema: 1, years: {
    2040: { year: 2040, source: "holiday-cn", version: "holiday-cn", fetchedAt: stale, data: {
      "2040-01-01": { name: "元旦", status: "workday" },
      "2040-12-30": { name: "元旦", status: "rest" },
      "2040-12-31": { name: "元旦", status: "workday" },
    } },
  } }));
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => url.includes("timor.tech")
      ? { code: 0, holiday: {} } : holidayCnPayload(2040, [
        { date: "2040-01-01", name: "元旦", isOffDay: true },
        { date: "2040-12-30", name: "元旦", isOffDay: false },
      ]) };
  };
  assert.deepEqual(await fetchHolidayYear(2040), {
    "2040-01-01": { name: "元旦", status: "rest" },
    "2040-12-30": { name: "元旦", status: "rest" },
    "2040-12-31": { name: "元旦", status: "workday" },
  });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes("2040")));
  assert.equal(getHolidayYearInfo(2040).expired, false);
});

test("fallback never requests a year beyond the supported range", async () => {
  setRequestDate(2100);
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => url.includes("timor.tech")
      ? { code: 0, holiday: {} } : holidayCnPayload(2100) };
  };
  assert.ok(await fetchHolidayYear(2100));
  assert.equal(urls.length, 2);
});

test("concurrent callers share the entire fallback sequence", async () => {
  setRequestDate(2040);
  const urls = [];
  let resolveResponse;
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes("timor.tech")) return { ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) };
    return new Promise((resolve) => {
      resolveResponse = () => resolve({ ok: true, status: 200, json: async () => holidayCnPayload(2040) });
    });
  };
  const first = fetchHolidayYear(2040);
  const second = fetchHolidayYear(2040);
  await new Promise((resolve) => setImmediate(resolve));
  resolveResponse();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(urls.length, 2);
});

test("cancellation aborts a fallback body read without caching or starting the next source", async () => {
  setRequestDate(2040);
  let calls = 0;
  let bodyStarted;
  const bodyReady = new Promise((resolve) => { bodyStarted = resolve; });
  globalThis.fetch = async (_url, options) => {
    if (++calls === 1) return { ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) };
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      bodyStarted();
    }) };
  };
  const pending = fetchHolidayYear(2040);
  await bodyReady;
  cancelHolidayRequests();
  assert.equal(await pending, null);
  assert.equal(calls, 2);
  assert.equal(getHolidayYearInfo(2040).available, false);
});

test("fallback domain is allowed by the packaged app CSP", async () => {
  const config = JSON.parse(await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const connectSrc = config.app.security.csp.split(";").find((directive) => directive.trim().startsWith("connect-src"));
  assert.ok(connectSrc.split(/\s+/).includes("https://cdn.jsdelivr.net"));
  assert.ok(connectSrc.split(/\s+/).includes("https://timor.tech"));
});

test("missing data labels do not imply the official arrangements are unpublished", () => {
  assert.equal(translator("zh_CN").t("calendar.holidayPending"), "下次假期数据暂不可用");
  assert.equal(translator("en_US").t("calendar.holidayPending"), "Next holiday data unavailable");
});

test("malformed remote payload returns null without caching", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ holiday: "not-an-object" }) });
  const data = await fetchHolidayYear(2028);
  assert.equal(data, null);
  assert.equal(getHolidayYearInfo(2028).available, false);
  assert.equal(getCachedHolidayYears()[2028], undefined);
});

test("impossible civil dates and empty caches are rejected", async () => {
  setRequestDate(2041);
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
  setRequestDate(2042);
  let calls = 0;
  fetchConfig.backoff = [15];
  fetchConfig.retries = 1;
  globalThis.fetch = async () => { calls++; throw new Error("offline"); };
  const request = fetchHolidayYear(2042);
  await new Promise((resolve) => setTimeout(resolve, 2));
  cancelHolidayRequests();
  assert.equal(await request, null);
  assert.equal(calls, 2); // primary and fallback, but no second round
});

test("malformed cached entry is ignored and re-fetched", async () => {
  setRequestDate(2029);
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

test("network failures exhaust the daily round budget and reset the next day", async () => {
  setRequestDate(2030);
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
  assert.equal(attempts, 4); // two rounds, each with a primary and fallback request
  setRequestDate(2030, 10, 10);
  assert.equal(await fetchHolidayYear(2030, true), null);
  assert.equal(attempts, 8);
});

test("retry with backoff succeeds on a later round and stops after success", async () => {
  setRequestDate(2032);
  let attempts = 0;
  fetchConfig.retries = 2;
  fetchConfig.backoff = [5, 5];
  fetchConfig.timeout = 1000;
  globalThis.fetch = async (url) => {
    attempts += 1;
    if (url.includes("jsdelivr")) return { ok: false, status: 404 };
    if (attempts === 1) throw new Error("transient");
    return {
      ok: true,
      status: 200,
      json: async () => ({ holiday: { "2032-01-01": { date: "2032-01-01", name: "元旦", holiday: true } } }),
    };
  };
  const data = await fetchHolidayYear(2032, true);
  assert.equal(attempts, 3);
  assert.equal(data["2032-01-01"].status, "rest");
  assert.deepEqual(await fetchHolidayYear(2032), data);
  assert.equal(attempts, 3);
});

test("concurrent requests are de-duplicated", async () => {
  setRequestDate(2033);
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
  const data = await fetchHolidayYear(2034, false);
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
  setRequestDate(2036);
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
  setRequestDate(2038);
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

test("cancelled fetch reserves a round but allows the remaining daily retries", async () => {
  setRequestDate(2039);
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
  assert.equal(calls, 1);
  setRequestDate(2039, 10, 10);
  assert.equal(await fetchHolidayYear(2039, true), null);
  assert.equal(calls, 3);
});

test("getCachedHolidayYears includes built-in years", () => {
  const cached = getCachedHolidayYears();
  assert.ok(cached[2026]);
  assert.equal(cached[2026]["2026-01-01"].status, "rest");
});

test("strict validation: one malformed entry among valid ones rejects the entire year", async () => {
  setRequestDate(2030);
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
  setRequestDate(2031);
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
  setRequestDate(2032);
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
  setRequestDate(2033);
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
  setRequestDate(2034);
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
  setRequestDate(2035);
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
  setRequestDate(2036);
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
