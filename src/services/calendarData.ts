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
  // Cache age for display only; online polling follows the November daily
  // schedule. Built-in data never expires; missing data has no expiry flag.
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
  requests?: Record<number, HolidayRequestState>;
}

interface HolidayRequestState {
  day: string;
  attempts: number;
  done: boolean;
}

const BUILT_IN_SOURCE = "内置整理数据";
const BUILT_IN_VERSION = "built-in-2007-2027";
const REMOTE_SOURCE = "timor.tech（非官方源）";
const REMOTE_VERSION = "timor";
const FALLBACK_SOURCE = "holiday-cn（非官方源，经 jsDelivr）";
const FALLBACK_VERSION = "holiday-cn";

const CACHE_KEY = "dogecalendar.holidays.v1";
const CACHE_SCHEMA = 1;

export const fetchConfig = {
  timeout: 8000,
  retries: 3,
  backoff: [500, 1500],
  cacheTtl: 30 * 24 * 60 * 60 * 1000,
};

const remoteHolidayRequests = new Map<number, Promise<HolidayYear | null>>();
const remoteControllers = new Map<number, AbortController>();
const remoteRequestStates = new Map<number, HolidayRequestState>();

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

function readRequestState(year: number): HolidayRequestState | undefined {
  const stored = readCache()?.requests?.[year];
  const valid = stored && typeof stored === "object" && typeof stored.day === "string" &&
    isValidDateKey(stored.day, year - 1) && Number.isInteger(stored.attempts) && stored.attempts >= 0 &&
    typeof stored.done === "boolean" ? stored : undefined;
  const memory = remoteRequestStates.get(year);
  if (!memory) return valid;
  if (!valid) return memory;
  if (memory.day !== valid.day) return memory.day > valid.day ? memory : valid;
  return { day: memory.day, attempts: Math.max(memory.attempts, valid.attempts), done: memory.done || valid.done };
}

function writeRequestState(year: number, state: HolidayRequestState) {
  const current = readRequestState(year);
  if (current && current.day > state.day) return;
  const merged = current?.day === state.day
    ? { ...state, attempts: Math.max(current.attempts, state.attempts), done: current.done || state.done }
    : state;
  remoteRequestStates.set(year, merged);
  const cache = readCache() ?? { schema: CACHE_SCHEMA, years: {} };
  cache.requests = { ...cache.requests, [year]: merged };
  writeCache(cache);
}

function parseTimorPayload(year: number, payload: unknown): HolidayYear | null {
  if (!payload || typeof payload !== "object") return null;
  const code = (payload as { code?: unknown }).code;
  if (code !== undefined && code !== 0) return null;
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

function parseHolidayCnPayload(year: number, payload: unknown): HolidayYear | null {
  if (!payload || typeof payload !== "object") return null;
  const { year: payloadYear, papers, days } = payload as Record<string, unknown>;
  if (payloadYear !== year || !Array.isArray(days) || days.length === 0) return null;
  if (!Array.isArray(papers) || papers.length === 0 || papers.some((paper) => typeof paper !== "string" || !paper.trim())) return null;
  const result: HolidayYear = {};
  for (const entry of days) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { date, name, isOffDay } = entry as Record<string, unknown>;
    if (typeof date !== "string" || typeof name !== "string" || !name.trim() || typeof isOffDay !== "boolean") return null;
    // Files follow the announcement year, so New Year arrangements may also
    // include the previous December rather than only dates in the title year.
    if (!isValidDateKey(date, year) && !(isValidDateKey(date, year - 1) && date.slice(5, 7) === "12")) return null;
    if (result[date]) return null;
    result[date] = { name: name.trim(), status: isOffDay ? "rest" : "workday" };
  }
  return result;
}

async function fetchHolidaySource(
  year: number,
  url: string,
  parse: (year: number, payload: unknown) => HolidayYear | null,
  cancellation: AbortSignal,
): Promise<{ data: HolidayYear | null; retryable: boolean }> {
  if (cancellation.aborted) return { data: null, retryable: false };
  const controller = new AbortController();
  const abort = () => controller.abort();
  cancellation.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), fetchConfig.timeout);
  try {
    let response: Response;
    try {
      // Bound both response headers and body reads by the same timeout.
      response = await fetch(url, { signal: controller.signal });
    } catch {
      return { data: null, retryable: !cancellation.aborted };
    }
    if (response.status >= 500) return { data: null, retryable: true };
    if (!response.ok) return { data: null, retryable: false };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return { data: null, retryable: !cancellation.aborted && !(error instanceof SyntaxError) };
    }
    const parsed = parse(year, payload);
    return { data: cancellation.aborted ? null : parsed, retryable: false };
  } finally {
    clearTimeout(timer);
    cancellation.removeEventListener("abort", abort);
  }
}

async function fetchRemoteHolidayYear(year: number, cancellation: AbortSignal): Promise<{ data: HolidayYear | null; retryable: boolean }> {
  const primary = await fetchHolidaySource(year, `https://timor.tech/api/holiday/year/${year}`, parseTimorPayload, cancellation);
  let data = primary.data;
  let retryable = primary.retryable;
  let source = REMOTE_SOURCE;
  let version = REMOTE_VERSION;
  if (!data && !cancellation.aborted) {
    const url = `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;
    const fallback = await fetchHolidaySource(year, url, parseHolidayCnPayload, cancellation);
    retryable ||= fallback.retryable;
    if (!fallback.data || cancellation.aborted) return { data: null, retryable };
    data = Object.fromEntries(Object.entries(fallback.data).filter(([date]) => isValidDateKey(date, year)));
    if (Object.keys(data).length === 0) return { data: null, retryable };
    // Never probe the third year. Preserve any December adjustments cached by
    // older versions that read the following year's announcement.
    const cached = readCachedHolidayYear(year);
    if (cached) {
      for (const [date, entry] of Object.entries(cached.data)) {
        if (date.slice(5, 7) !== "12") continue;
        data[date] = entry;
      }
    }
    source = FALLBACK_SOURCE;
    version = FALLBACK_VERSION;
  }
  if (!data || cancellation.aborted) return { data: null, retryable };
  writeCachedHolidayYear({ year, data, source, version, fetchedAt: Date.now() });
  return { data, retryable: false };
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
  const now = new Date();
  // Only poll next year's arrangements from November 1 through December 31.
  // Browsing other years, including missing historical years, stays offline.
  if (!allowNetwork || now.getMonth() < 10 || year !== now.getFullYear() + 1) return cached?.data ?? null;
  const existing = remoteHolidayRequests.get(year);
  if (existing) return existing;
  const today = dateKey(now);
  const previous = readRequestState(year);
  const maxAttempts = 1 + fetchConfig.retries;
  if (previous && (previous.day > today || (previous.day === today && (previous.done || previous.attempts >= maxAttempts)))) return cached?.data ?? null;
  if (!previous && cached && dateKey(new Date(cached.fetchedAt)) >= today) return cached.data;
  const controller = new AbortController();
  remoteControllers.set(year, controller);
  const request = (async () => {
    while (!controller.signal.aborted) {
      const current = new Date();
      // Retries cannot cross a local day or the annual request window.
      if (dateKey(current) !== today || current.getMonth() < 10 || year !== current.getFullYear() + 1) break;
      const state = readRequestState(year);
      const attempts = state?.day === today ? state.attempts : 0;
      if (state && (state.day > today || (state.day === today && (state.done || attempts >= maxAttempts)))) break;
      if (attempts > 0) {
        const index = Math.min(attempts - 1, fetchConfig.backoff.length - 1);
        await delay(fetchConfig.backoff[index] ?? 1000);
        if (controller.signal.aborted || dateKey(new Date()) !== today) break;
      }
      // Reserve each round before fetching; restarts and cancellation must not
      // reset the daily retry budget. Only valid new data marks success.
      writeRequestState(year, { day: today, attempts: attempts + 1, done: false });
      const result = await fetchRemoteHolidayYear(year, controller.signal);
      if (controller.signal.aborted) break;
      if (result.data || !result.retryable) {
        writeRequestState(year, { day: today, attempts: attempts + 1, done: true });
        return result.data ?? cached?.data ?? null;
      }
    }
    return cached?.data ?? null;
  })().finally(() => {
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
