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

const lunarFestivals: Record<string, string> = {
  "正月-1": "春节",
  "正月-15": "元宵节",
  "五月-5": "端午节",
  "七月-7": "七夕",
  "八月-15": "中秋节",
  "九月-9": "重阳节",
};

const lunarDayNames = ["初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"];

type HolidayOverride = { name: string; status: "holiday" | "rest" | "workday" };

// Built-in annual data is intentionally replaceable by a remote provider later.
const annualHolidayOverrides: Record<number, Record<string, HolidayOverride>> = {
  2026: {
    "2026-01-01": { name: "元旦", status: "holiday" },
    "2026-02-15": { name: "春节", status: "rest" },
    "2026-02-16": { name: "春节", status: "holiday" },
    "2026-02-17": { name: "春节", status: "holiday" },
    "2026-02-18": { name: "春节", status: "rest" },
    "2026-02-19": { name: "春节", status: "rest" },
    "2026-02-20": { name: "春节", status: "workday" },
    "2026-04-04": { name: "清明节", status: "holiday" },
    "2026-05-01": { name: "劳动节", status: "holiday" },
    "2026-06-19": { name: "端午节", status: "holiday" },
    "2026-09-20": { name: "中秋节", status: "workday" },
    "2026-09-25": { name: "中秋节", status: "holiday" },
    "2026-10-01": { name: "国庆节", status: "holiday" },
    "2026-10-02": { name: "国庆节", status: "holiday" },
    "2026-10-03": { name: "国庆节", status: "holiday" },
    "2026-10-04": { name: "国庆节", status: "rest" },
    "2026-10-05": { name: "国庆节", status: "rest" },
    "2026-10-06": { name: "国庆节", status: "rest" },
    "2026-10-07": { name: "国庆节", status: "rest" },
    "2026-10-10": { name: "国庆节", status: "workday" },
  },
};

function getAnnualHoliday(date: Date) {
  return annualHolidayOverrides[date.getFullYear()]?.[dateKey(date)];
}

function lunarParts(date: Date) {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric",
    });
    const parts = formatter.formatToParts(date);
    return {
      month: parts.find((part) => part.type === "month")?.value ?? "",
      day: Number(parts.find((part) => part.type === "day")?.value ?? 0),
    };
  } catch {
    return { month: "", day: 0 };
  }
}

function lunarText(date: Date) {
  const { month, day } = lunarParts(date);
  if (!day) return "农历";
  return `${month}${lunarDayNames[day - 1] ?? day}`;
}

function lunarDayText(date: Date) {
  const { day } = lunarParts(date);
  if (!day) return "";
  return lunarDayNames[day - 1] ?? String(day);
}

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getCalendarMeta(date: Date): CalendarMeta {
  const monthDay = `${date.getMonth() + 1}-${date.getDate()}`;
  const { month, day } = lunarParts(date);
  const lunarHoliday = day ? lunarFestivals[`${month}-${day}`] : undefined;
  const holiday = fixedHolidays[monthDay] ?? lunarHoliday;
  const solarTerm = solarTerms[monthDay];
  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
  const annualHoliday = getAnnualHoliday(date);
  const resolvedHoliday = annualHoliday?.name ?? holiday;
  const resolvedStatus = annualHoliday?.status;

  return {
    lunar: lunarText(date),
    lunarDay: lunarDayText(date),
    solarTerm,
    holiday: resolvedHoliday,
    holidayType: resolvedStatus === "workday" ? "workday" : resolvedHoliday ? "holiday" : isWeekend ? "rest" : "workday",
    holidayStatus: resolvedStatus ?? (resolvedHoliday ? "holiday" : isWeekend ? "rest" : "workday"),
  };
}
