import { holidayOverrides, type HolidayOverride } from "../data/holidayOverrides";

export type HolidayType = "holiday" | "rest" | "workday" | "none";

export type CalendarMeta = {
  lunar: string;
  lunarDay: string;
  solarTerm?: string;
  holiday?: string;
  holidayType: HolidayType;
  holidayStatus?: "holiday" | "rest" | "workday";
};

const solarTerms: Record<string, string> = {
  "2-4": "立春", "2-19": "雨水", "3-6": "惊蛰", "3-21": "春分",
  "4-5": "清明", "4-20": "谷雨", "5-6": "立夏", "5-21": "小满",
  "6-6": "芒种", "6-21": "夏至", "7-7": "小暑", "7-23": "大暑",
  "8-8": "立秋", "8-23": "处暑", "9-8": "白露", "9-23": "秋分",
  "10-8": "寒露", "10-23": "霜降", "11-7": "立冬", "11-22": "小雪",
  "12-7": "大雪", "12-22": "冬至",
};

const fixedHolidays: Record<string, string> = {
  "1-1": "元旦",
  "3-8": "妇女节",
  "5-1": "劳动节",
  "6-1": "儿童节",
  "10-1": "国庆节",
};

const publicFixedHolidays = new Set(["1-1", "5-1", "10-1"]);

const lunarFestivals: Record<string, string> = {
  "正月-1": "春节",
  "正月-15": "元宵节",
  "五月-5": "端午节",
  "七月-7": "七夕",
  "八月-15": "中秋节",
  "九月-9": "重阳节",
};

const publicLunarFestivals = new Set(["正月-1", "五月-5", "八月-15"]);

const lunarDayNames = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];

export type HolidayYear = Record<string, HolidayOverride>;
export type HolidayYears = Record<number, HolidayYear>;

const remoteHolidayRequests = new Map<number, Promise<HolidayYear | null>>();

export async function fetchHolidayYear(year: number): Promise<HolidayYear | null> {
  if (holidayOverrides[year]) return holidayOverrides[year];
  const existing = remoteHolidayRequests.get(year);
  if (existing) return existing;

  const request = fetch(`https://timor.tech/api/holiday/year/${year}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`节假日接口请求失败（${response.status}）`);
      const payload = await response.json() as { holiday?: Record<string, { date?: string; name?: string; holiday?: boolean }> };
      const entries = Object.values(payload.holiday ?? {});
      const result: HolidayYear = {};
      for (const entry of entries) {
        if (!entry.date || !entry.name || !entry.date.startsWith(`${year}-`)) continue;
        result[entry.date] = { name: entry.name, status: entry.holiday ? "rest" : "workday" };
      }
      return result;
    })
    .catch(() => null);
  remoteHolidayRequests.set(year, request);
  return request;
}

function lunarParts(date: Date) {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric",
    });
    const parts = formatter.formatToParts(date);
    const dayText = parts.find((part) => part.type === "day")?.value ?? "";
    return {
      month: parts.find((part) => part.type === "month")?.value ?? "",
      day: Number(dayText) || lunarDayNames.indexOf(dayText) + 1,
    };
  } catch {
    return { month: "", day: 0 };
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
  const { month, day } = lunarParts(date);
  const lunarKey = `${month}-${day}`;
  const lunarHoliday = day ? lunarFestivals[lunarKey] : undefined;
  const holiday = fixedHolidays[monthDay] ?? lunarHoliday;
  const solarTerm = solarTerms[monthDay];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const annualHoliday = (annualHolidayOverrides?.[date.getFullYear()] ?? holidayOverrides[date.getFullYear()])?.[dateKey(date)];
  // Annual entries drive rest/work markers; the festival label belongs only to
  // the actual fixed or lunar festival date, not every day in the holiday break.
  const resolvedHoliday = holiday;
  const resolvedStatus = annualHoliday?.status ?? (publicFixedHolidays.has(monthDay) || (day > 0 && publicLunarFestivals.has(lunarKey)) ? "holiday" : undefined);

  return {
    lunar: day ? `${month}${lunarDayNames[day - 1] ?? day}` : "农历",
    lunarDay: day ? lunarDayNames[day - 1] ?? String(day) : "",
    solarTerm,
    holiday: resolvedHoliday,
    holidayType: resolvedStatus ?? (isWeekend ? "rest" : "workday"),
    holidayStatus: resolvedStatus,
  };
}
