// Offline civil (Gregorian) date utilities shared by the calendar.
// Deliberately does not import calendarData to avoid pulling lunar-typescript
// into this module's dependency graph. All date math uses UTC civil ordinals
// (Date.UTC of local civil Y/M/D) so DST transitions never shift the day count,
// and parsed/added dates are anchored at local noon to stay off the 00:00 wall.

export const CIVIL_MIN_YEAR = 1900;
export const CIVIL_MAX_YEAR = 2100;

const MS_PER_DAY = 86400000;

function civilUtcOrdinal(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function isValidDateInstance(date: unknown): date is Date {
  return date instanceof Date && Number.isFinite(date.getTime());
}

function inCivilRange(year: number): boolean {
  return Number.isInteger(year) && year >= CIVIL_MIN_YEAR && year <= CIVIL_MAX_YEAR;
}

/**
 * Parse a "YYYY-MM-DD" string (or a Date whose civil components are validated)
 * into a local-noon Date. Strict: no rollover (Feb 30 is rejected, not Mar 2),
 * year constrained to [1900, 2100], month 1-12, day valid for the month/year
 * including leap-year rules. Returns null for anything invalid.
 */
export function parseCivilDate(value: string | Date): Date | null {
  let year: number;
  let month: number;
  let day: number;
  if (value instanceof Date) {
    if (!isValidDateInstance(value)) return null;
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) return null;
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  } else {
    return null;
  }

  if (!inCivilRange(year)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1) return null;

  // Construct at local noon and verify no rollover occurred. A constructed
  // Date auto-rolls invalid days (e.g. Feb 30 -> Mar 2); the equality check
  // rejects those instead of silently returning a different calendar date.
  const candidate = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return null;
  }
  return candidate;
}

/**
 * Whole-day difference end - start, counting only civil calendar days. Because
 * the ordinals are computed from Date.UTC of each date's civil Y/M/D, DST
 * transitions (23h or 25h days) do not affect the result. end == start => 0;
 * end is the next civil day => 1 (start day is not included). Negative when end
 * is before start. Returns NaN when either argument is not a finite Date.
 */
export function differenceInDays(start: Date, end: Date): number {
  if (!isValidDateInstance(start) || !isValidDateInstance(end)) return NaN;
  const startOrdinal = civilUtcOrdinal(start);
  const endOrdinal = civilUtcOrdinal(end);
  return Math.round((endOrdinal - startOrdinal) / MS_PER_DAY);
}

export function daysRemainingInYear(date: Date): number {
  if (!isValidDateInstance(date)) return NaN;
  return differenceInDays(date, new Date(date.getFullYear(), 11, 31, 12));
}

/**
 * Add a whole number of calendar days to a date, returning a local-noon Date
 * whose civil Y/M/D is the result. Arithmetic is done on the UTC civil ordinal
 * so DST never distorts the day count. `days` must be a finite integer; the
 * resulting year must stay within [1900, 2100], otherwise null is returned.
 */
export function addCalendarDays(date: Date, days: number): Date | null {
  if (!isValidDateInstance(date)) return null;
  if (!Number.isFinite(days) || !Number.isInteger(days)) return null;

  const baseOrdinal = civilUtcOrdinal(date);
  const targetUtcMs = baseOrdinal + days * MS_PER_DAY;
  const targetUtc = new Date(targetUtcMs);
  const year = targetUtc.getUTCFullYear();
  if (!inCivilRange(year)) return null;

  // Rebuild from the UTC civil Y/M/D as a local-noon date so the returned Date
  // reports the expected civil components regardless of the host timezone.
  return new Date(year, targetUtc.getUTCMonth(), targetUtc.getUTCDate(), 12, 0, 0, 0);
}

/**
 * Format a Date as a canonical civil "YYYY-MM-DD" string using its local civil
 * components (noon-anchored dates are stable). Returns "" for invalid input.
 * This is locale-independent; for a localized display string callers should use
 * Date.prototype.toLocaleDateString with their own locale.
 */
export function formatCivilDate(date: Date): string {
  if (!isValidDateInstance(date)) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
