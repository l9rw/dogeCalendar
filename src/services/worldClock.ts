export function relativeOffsetMinutes(offsetMinutes: number, localTimezoneOffset: number): number {
  return offsetMinutes + localTimezoneOffset;
}

export function localizedClockDate(value: string, locale: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { month: "short", day: "numeric", weekday: "short" }) : value;
}
