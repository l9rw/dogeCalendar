import { Solar } from "lunar-typescript";
import { holidayOverrides, type HolidayOverride } from "../data/holidayOverrides.ts";
import { addCalendarDays, differenceInDays, parseCivilDate } from "./dateTools.ts";

export type HolidayType = "holiday" | "rest" | "workday" | "none";

export type CalendarMeta = {
  lunar: string;
  lunarDay: string;
  solarTerm?: string;
  holiday?: string;
  holidayType: HolidayType;
  holidayStatus?: "holiday" | "rest" | "workday";
};

// Festival labels are display-only metadata and are intentionally kept separate
// from the rest/workday arrangements, which must come from confirmed annual
// data. Unknown years never receive a guessed legal rest/workday status.
const fixedHolidays: Record<string, string> = {
  "1-1": "元旦",
  "3-8": "妇女节",
  "5-1": "劳动节",
  "6-1": "儿童节",
  "10-1": "国庆节",
};

const lunarFestivals: Record<string, string> = {
  "正月-1": "春节",
  "正月-15": "元宵节",
  "五月-5": "端午节",
  "七月-7": "七夕",
  "八月-15": "中秋节",
  "九月-9": "重阳节",
};

export type HolidayYear = Record<string, HolidayOverride>;
export type HolidayYears = Record<number, HolidayYear>;

export interface HolidayYearInfo {
  available: boolean;
  source: string;
  version: string;
  fetchedAt?: number;
  // True when cached remote data is past cacheTtl; false for built-in (never
  // expires); undefined when no data exists. Lets the UI show a stale badge
  // and trigger a refresh without implying the data is missing.
  expired?: boolean;
  // True for built-in curated data. Built-in takes priority over remote cache
  // and is always treated as fresh. The label is non-official curated data,
  // never an officially-verified claim.
  builtIn?: boolean;
}

export interface HolidayChange {
  date: string;
  name: string;
  status: "rest" | "workday";
}

interface CachedHolidayYear {
  year: number;
  data: HolidayYear;
  source: string;
  version: string;
  fetchedAt: number;
}

interface HolidayCachePayload {
  schema: number;
  years: Record<number, CachedHolidayYear>;
}

const BUILT_IN_SOURCE = "内置整理数据";
const BUILT_IN_VERSION = "built-in-2007-2026";
const REMOTE_SOURCE = "timor.tech（非官方源）";
const REMOTE_VERSION = "timor";

const CACHE_KEY = "dogecalendar.holidays.v1";
const CACHE_SCHEMA = 1;

export const fetchConfig = {
  timeout: 8000,
  retries: 2,
  backoff: [500, 1500],
  cacheTtl: 30 * 24 * 60 * 60 * 1000,
};

const remoteHolidayRequests = new Map<number, Promise<HolidayYear | null>>();
const remoteControllers = new Map<number, AbortController>();

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getStorage(): Storage | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

function readCache(): HolidayCachePayload | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== CACHE_SCHEMA || typeof parsed.years !== "object" || !parsed.years) return null;
    return parsed as HolidayCachePayload;
  } catch {
    return null;
  }
}

function writeCache(payload: HolidayCachePayload) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota or unavailable storage; the in-memory result is still returned.
  }
}

function isValidOverride(value: unknown): value is HolidayOverride {
  if (!value || typeof value !== "object") return false;
  const override = value as Record<string, unknown>;
  return typeof override.name === "string" && override.name.trim().length > 0 &&
    (override.status === "rest" || override.status === "workday");
}

function isValidDateKey(key: string, year: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return false;
  if (Number(match[1]) !== year) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

function isValidCachedEntry(entry: unknown, year: number): entry is CachedHolidayYear {
  if (!entry || typeof entry !== "object") return false;
  const cached = entry as Record<string, unknown>;
  if (typeof cached.year !== "number" || cached.year !== year) return false;
  if (typeof cached.source !== "string" || typeof cached.version !== "string") return false;
  if (typeof cached.fetchedAt !== "number" || !Number.isFinite(cached.fetchedAt)) return false;
  if (!cached.data || typeof cached.data !== "object" || Array.isArray(cached.data) || Object.keys(cached.data).length === 0) return false;
  for (const [key, value] of Object.entries(cached.data as Record<string, unknown>)) {
    if (!isValidDateKey(key, year)) return false;
    if (!isValidOverride(value)) return false;
  }
  return true;
}

function readCachedHolidayYear(year: number): CachedHolidayYear | null {
  const cache = readCache();
  if (!cache?.years) return null;
  const entry = cache.years[year];
  return isValidCachedEntry(entry, year) ? entry : null;
}

function writeCachedHolidayYear(entry: CachedHolidayYear) {
  const cache = readCache() ?? { schema: CACHE_SCHEMA, years: {} };
  cache.years[entry.year] = entry;
  writeCache(cache);
}

function parseTimorPayload(year: number, payload: unknown): HolidayYear | null {
  if (!payload || typeof payload !== "object") return null;
  const holiday = (payload as { holiday?: unknown }).holiday;
  if (!holiday || typeof holiday !== "object" || Array.isArray(holiday)) return null;
  const entries = Object.values(holiday as Record<string, unknown>);
  if (entries.length === 0) return null;
  const result: HolidayYear = {};
  for (const entry of entries) {
    // Strict validation: any structurally malformed entry invalidates the
    // entire year. A partial response must never be silently cached and
    // presented as complete holiday data — one bad entry means the source
    // is unreliable for this year, so we reject the whole payload.
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const date = record.date;
    const name = record.name;
    const isRest = record.holiday;
    if (typeof date !== "string" || !isValidDateKey(date, year)) return null;
    if (typeof name !== "string" || name.trim().length === 0) return null;
    if (typeof isRest !== "boolean") return null;
    if (result[date]) return null; // duplicate date = conflicting arrangements
    result[date] = { name: name.trim(), status: isRest ? "rest" : "workday" };
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function fetchRemoteHolidayYear(year: number, cancellation: AbortSignal): Promise<HolidayYear | null> {
  const url = `https://timor.tech/api/holiday/year/${year}`;
  for (let attempt = 0; attempt <= fetchConfig.retries; attempt++) {
    if (cancellation.aborted) return null;
    if (attempt > 0) {
      const index = Math.min(attempt - 1, fetchConfig.backoff.length - 1);
      await delay(fetchConfig.backoff[index] ?? 1000);
    }
    if (cancellation.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    cancellation.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), fetchConfig.timeout);
    try {
      let response: Response;
      try {
        // The abort signal stays active through response.json() so a slow body
        // read is also bounded by the timeout, not just the response headers.
        response = await fetch(url, { signal: controller.signal });
      } catch (error) {
        if (cancellation.aborted) return null;
        if (isAbortError(error)) continue; // timeout on headers -> retry
        continue; // transient network error -> retry with backoff
      }
      if (response.status >= 500) continue; // transient server error -> retry
      if (!response.ok) return null; // 4xx -> hard fail, no cache
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (cancellation.aborted) return null;
        if (isAbortError(error)) continue; // timeout while reading body -> retry
        return null; // malformed JSON -> hard fail, no cache
      }
      const parsed = parseTimorPayload(year, payload);
      if (!parsed) return null; // invalid payload -> hard fail, no cache
      if (cancellation.aborted) return null;
      writeCachedHolidayYear({ year, data: parsed, source: REMOTE_SOURCE, version: REMOTE_VERSION, fetchedAt: Date.now() });
      return parsed;
    } finally {
      clearTimeout(timer);
      cancellation.removeEventListener("abort", abort);
    }
  }
  return null;
}

export function cancelHolidayRequests(): void {
  for (const controller of remoteControllers.values()) {
    try { controller.abort(); } catch { /* ignore */ }
  }
  remoteControllers.clear();
  remoteHolidayRequests.clear();
}

export async function fetchHolidayYear(year: number, allowNetwork = true): Promise<HolidayYear | null> {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (holidayOverrides[year]) return holidayOverrides[year];
  const cached = readCachedHolidayYear(year);
  if (cached) {
    const fresh = Date.now() - cached.fetchedAt <= fetchConfig.cacheTtl;
    if (fresh || !allowNetwork) return cached.data;
  }
  // Network disabled takes precedence over joining an in-flight request so a
  // caller that just turned networking off never waits on a failing fetch.
  if (!allowNetwork) return null;
  const existing = remoteHolidayRequests.get(year);
  if (existing) return existing;
  const controller = new AbortController();
  remoteControllers.set(year, controller);
  const request = fetchRemoteHolidayYear(year, controller.signal)
    .then((data) => data ?? cached?.data ?? null)
    .finally(() => {
      if (remoteHolidayRequests.get(year) === request) remoteHolidayRequests.delete(year);
      if (remoteControllers.get(year) === controller) remoteControllers.delete(year);
    });
  remoteHolidayRequests.set(year, request);
  return request;
}

export function getHolidayYearInfo(year: number): HolidayYearInfo {
  if (holidayOverrides[year]) {
    return { available: true, source: BUILT_IN_SOURCE, version: BUILT_IN_VERSION, expired: false, builtIn: true };
  }
  const cached = readCachedHolidayYear(year);
  if (cached) {
    return {
      available: true,
      source: cached.source,
      version: cached.version,
      fetchedAt: cached.fetchedAt,
      expired: Date.now() - cached.fetchedAt > fetchConfig.cacheTtl,
      builtIn: false,
    };
  }
  return { available: false, source: "未知", version: "unknown", builtIn: false };
}

export function getCachedHolidayYears(): HolidayYears {
  const result: HolidayYears = {};
  for (const [key, data] of Object.entries(holidayOverrides)) {
    const year = Number(key);
    if (Number.isInteger(year)) result[year] = data;
  }
  const cache = readCache();
  if (cache?.years) {
    for (const [key, entry] of Object.entries(cache.years)) {
      const year = Number(key);
      // Built-in curated data takes priority: never overwrite a built-in year
      // with a cached remote entry, since the built-in set is the trusted
      // reference and is always treated as fresh.
      if (Number.isInteger(year) && !result[year] && isValidCachedEntry(entry, year)) {
        result[year] = entry.data;
      }
    }
  }
  return result;
}

export function getNextHolidayChange(from: Date, holidayYears: HolidayYears): HolidayChange | null {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  for (let offset = 0; offset < 400; offset++) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const annual = holidayYears[date.getFullYear()]?.[dateKey(date)];
    if (annual) {
      return { date: dateKey(date), name: annual.name, status: annual.status };
    }
  }
  return null;
}

export function getHolidayCountdown(from: Date, holidayYears: HolidayYears): {
  kind: "current" | "upcoming";
  name: string;
  date: string;
  days: number;
} | null {
  const today = parseCivilDate(from);
  if (!today) return null;
  for (let offset = 0; offset < 400; offset++) {
    const date = addCalendarDays(today, offset);
    if (!date) return null;
    const annual = holidayYears[date.getFullYear()];
    // Never skip an unknown year to advertise a later holiday as the next one.
    if (!annual) return null;
    const holiday = annual[dateKey(date)];
    if (holiday?.status !== "rest") continue;
    if (offset > 0) {
      return { kind: "upcoming", name: holiday.name, date: dateKey(date), days: offset };
    }
    // Consecutive recorded rest days form one break, even when adjacent
    // holidays use different names. Ordinary weekends do not extend it.
    let end = date;
    for (let remaining = 1; remaining < 400; remaining++) {
      const next = addCalendarDays(date, remaining);
      if (!next || !holidayYears[next.getFullYear()]) return null;
      if (holidayYears[next.getFullYear()][dateKey(next)]?.status !== "rest") {
        return { kind: "current", name: holiday.name, date: dateKey(end), days: differenceInDays(today, end) + 1 };
      }
      end = next;
    }
    return null;
  }
  return null;
}

function lunarParts(date: Date) {
  try {
    const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const lunar = solar.getLunar();
    const monthChinese = lunar.getMonthInChinese();
    const dayChinese = lunar.getDayInChinese();
    const day = lunar.getDay();
    const lunarKey = `${monthChinese}月-${day}`;
    const jieQi = lunar.getJieQi();
    return { month: monthChinese, day, dayChinese, lunarKey, solarTerm: jieQi || undefined };
  } catch {
    return { month: "", day: 0, dayChinese: "", lunarKey: "", solarTerm: undefined };
  }
}

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getCalendarMeta(date: Date, annualHolidayOverrides?: HolidayYears): CalendarMeta {
  const monthDay = `${date.getMonth() + 1}-${date.getDate()}`;
  const { month, day, dayChinese, lunarKey, solarTerm } = lunarParts(date);
  const lunarHoliday = day ? lunarFestivals[lunarKey] : undefined;
  const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const isNewYearEve = month === "腊" && lunarParts(nextDay).lunarKey === "正月-1";
  const holiday = fixedHolidays[monthDay] ?? lunarHoliday ?? (isNewYearEve ? "除夕" : solarTerm === "清明" ? "清明节" : undefined);
  const annual = (annualHolidayOverrides?.[date.getFullYear()] ?? holidayOverrides[date.getFullYear()])?.[dateKey(date)];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  // Rest/workday status comes only from confirmed annual arrangements; festival
  // labels never imply a rest/workday status, and unknown years stay unconfirmed.
  const resolvedStatus = annual?.status;

  return {
    lunar: day ? `${month}月${dayChinese}` : "农历",
    lunarDay: day ? dayChinese : "",
    solarTerm,
    holiday,
    holidayType: resolvedStatus ?? (isWeekend ? "rest" : "workday"),
    holidayStatus: resolvedStatus,
  };
}
