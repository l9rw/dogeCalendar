export function relativeOffsetMinutes(offsetMinutes: number, localTimezoneOffset: number): number {
  return offsetMinutes + localTimezoneOffset;
}

// A clock-based illustration, not an astronomical sunrise/sunset calculation.
export function isClockDaytime(time24: string): boolean {
  const hour = Number(time24.split(":")[0]);
  return hour >= 6 && hour < 18;
}

export function localizedClockDate(value: string, locale: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { month: "short", day: "numeric", weekday: "short" }) : value;
}
