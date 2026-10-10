import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCivilDate,
  differenceInDays,
  daysRemainingInYear,
  addCalendarDays,
  formatCivilDate,
  CIVIL_MIN_YEAR,
  CIVIL_MAX_YEAR,
} from "./dateTools.ts";

// parseCivilDate returns Date | null; tests need a guaranteed Date. Throw (and
// fail the test) if a date that should parse does not.
function civ(value) {
  const date = parseCivilDate(value);
  assert.ok(date instanceof Date, `expected parseable date for ${value}`);
  return date;
}

test("remaining year days exclude today and respect leap years", () => {
  assert.equal(daysRemainingInYear(new Date(2026, 9, 4, 23, 59)), 88);
  assert.equal(daysRemainingInYear(civ("2026-01-01")), 364);
  assert.equal(daysRemainingInYear(civ("2024-01-01")), 365);
  assert.equal(daysRemainingInYear(civ("2026-12-31")), 0);
  assert.equal(daysRemainingInYear(civ("2024-02-28")) - daysRemainingInYear(civ("2024-02-29")), 1);
  assert.ok(Number.isNaN(daysRemainingInYear(new Date(NaN))));
});

test("formatCivilDate pads month and day and uses local civil components", () => {
  assert.equal(formatCivilDate(civ("2026-01-05")), "2026-01-05");
  assert.equal(formatCivilDate(civ("2026-11-23")), "2026-11-23");
  assert.equal(formatCivilDate(new Date(NaN)), "");
});

test("parseCivilDate accepts a valid ISO calendar string at local noon", () => {
  const date = parseCivilDate("2026-10-03");
  assert.ok(date instanceof Date);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 9);
  assert.equal(date.getDate(), 3);
  assert.equal(date.getHours(), 12);
  assert.equal(date.getMinutes(), 0);
});

test("parseCivilDate rejects out-of-range years", () => {
  assert.equal(parseCivilDate("1899-12-31"), null);
  assert.equal(parseCivilDate(`${CIVIL_MAX_YEAR + 1}-01-01`), null);
  assert.equal(civ("1900-01-01").getFullYear(), CIVIL_MIN_YEAR);
  assert.equal(civ("2100-12-31").getFullYear(), CIVIL_MAX_YEAR);
});

test("parseCivilDate rejects 2/29 on non-leap years without rollover", () => {
  assert.ok(parseCivilDate("2024-02-29")); // leap
  assert.equal(parseCivilDate("2025-02-29"), null); // not leap, no rollover to Mar 1
  assert.equal(parseCivilDate("2100-02-29"), null); // 2100 is not a leap year (century non-divisible by 400)
  assert.equal(formatCivilDate(civ("2024-02-29")), "2024-02-29");
});

test("parseCivilDate rejects impossible days without rolling over", () => {
  assert.equal(parseCivilDate("2026-02-30"), null);
  assert.equal(parseCivilDate("2026-04-31"), null);
  assert.equal(parseCivilDate("2026-13-01"), null);
  assert.equal(parseCivilDate("2026-00-10"), null);
  assert.equal(parseCivilDate("2026-01-00"), null);
  assert.equal(parseCivilDate("2026-1-5"), null); // requires zero-padded YYYY-MM-DD
  assert.equal(parseCivilDate("not-a-date"), null);
  assert.equal(parseCivilDate(""), null);
});

test("parseCivilDate accepts a Date input by validating its civil components", () => {
  const valid = parseCivilDate(new Date(2026, 5, 15, 3, 30));
  assert.ok(valid);
  assert.equal(formatCivilDate(valid), "2026-06-15");
  assert.equal(valid.getHours(), 12); // re-anchored to noon
  assert.equal(parseCivilDate(new Date(NaN)), null);
  assert.equal(parseCivilDate(new Date(1899, 0, 1)), null);
});

test("differenceInDays counts whole civil days end - start, start not included", () => {
  const d = (s) => civ(s);
  assert.equal(differenceInDays(d("2026-10-03"), d("2026-10-03")), 0);
  assert.equal(differenceInDays(d("2026-10-03"), d("2026-10-04")), 1);
  assert.equal(differenceInDays(d("2026-10-03"), d("2026-10-05")), 2);
});

test("differenceInDays is negative when end is before start", () => {
  const d = (s) => civ(s);
  assert.equal(differenceInDays(d("2026-10-05"), d("2026-10-03")), -2);
  assert.equal(differenceInDays(d("2026-10-04"), d("2026-10-03")), -1);
});

test("differenceInDays crosses the year boundary correctly", () => {
  const d = (s) => civ(s);
  assert.equal(differenceInDays(d("2026-12-31"), d("2027-01-01")), 1);
  assert.equal(differenceInDays(d("2026-12-31"), d("2027-01-02")), 2);
  assert.equal(differenceInDays(d("2027-01-01"), d("2026-12-31")), -1);
});

test("differenceInDays is DST-immune via UTC civil ordinal", () => {
  const d = (s) => civ(s);
  // US 2026 DST spring-forward is 2026-03-08; the 23h local day must not distort the count.
  assert.equal(differenceInDays(d("2026-03-07"), d("2026-03-09")), 2);
  assert.equal(differenceInDays(d("2026-03-07"), d("2026-03-08")), 1);
  // US 2026 DST fall-back is 2026-11-01; the 25h local day must not distort the count.
  assert.equal(differenceInDays(d("2026-10-31"), d("2026-11-02")), 2);
  assert.equal(differenceInDays(d("2026-10-31"), d("2026-11-01")), 1);
  // Span across the spring DST boundary stays a whole number of days.
  assert.equal(differenceInDays(d("2026-03-06"), d("2026-03-10")), 4);
});

test("differenceInDays returns NaN for non-finite dates", () => {
  assert.ok(Number.isNaN(differenceInDays(new Date(NaN), new Date(2026, 0, 1))));
  assert.ok(Number.isNaN(differenceInDays(new Date(2026, 0, 1), new Date(NaN))));
});

test("addCalendarDays adds and subtracts whole calendar days, anchored at noon", () => {
  const d = (s) => civ(s);
  const plus1 = addCalendarDays(d("2026-10-03"), 1);
  assert.ok(plus1);
  assert.equal(formatCivilDate(plus1), "2026-10-04");
  assert.equal(plus1.getHours(), 12);
  const minus1 = addCalendarDays(d("2026-10-03"), -1);
  assert.ok(minus1);
  assert.equal(formatCivilDate(minus1), "2026-10-02");
  const zero = addCalendarDays(d("2026-10-03"), 0);
  assert.ok(zero);
  assert.equal(formatCivilDate(zero), "2026-10-03");
});

test("addCalendarDays crosses the year boundary", () => {
  const d = (s) => civ(s);
  const a = addCalendarDays(d("2026-12-31"), 1);
  assert.ok(a);
  assert.equal(formatCivilDate(a), "2027-01-01");
  const b = addCalendarDays(d("2027-01-01"), -1);
  assert.ok(b);
  assert.equal(formatCivilDate(b), "2026-12-31");
  const c = addCalendarDays(d("2026-12-31"), 366);
  assert.ok(c);
  assert.equal(formatCivilDate(c), "2028-01-01"); // 2027 is not a leap year
});

test("addCalendarDays is DST-immune and lands on the correct civil day at noon", () => {
  const d = (s) => civ(s);
  const acrossSpring = addCalendarDays(d("2026-03-07"), 2); // crosses 2026-03-08 spring-forward
  assert.ok(acrossSpring);
  assert.equal(formatCivilDate(acrossSpring), "2026-03-09");
  assert.equal(acrossSpring.getHours(), 12);
  const acrossFall = addCalendarDays(d("2026-10-31"), 2); // crosses 2026-11-01 fall-back
  assert.ok(acrossFall);
  assert.equal(formatCivilDate(acrossFall), "2026-11-02");
  assert.equal(acrossFall.getHours(), 12);
});

test("addCalendarDays handles 2/29 leap-day arithmetic without rollover distortion", () => {
  const d = (s) => civ(s);
  // 2024-02-28 + 1 = 2024-02-29 (leap day), +1 again = 2024-03-01
  assert.equal(formatCivilDate(addCalendarDays(d("2024-02-28"), 1)), "2024-02-29");
  assert.equal(formatCivilDate(addCalendarDays(d("2024-02-29"), 1)), "2024-03-01");
  assert.equal(formatCivilDate(addCalendarDays(d("2024-02-29"), -1)), "2024-02-28");
  // 2025-02-28 + 1 = 2025-03-01 (no leap day in 2025)
  assert.equal(formatCivilDate(addCalendarDays(d("2025-02-28"), 1)), "2025-03-01");
});

test("addCalendarDays rejects non-integer and non-finite day counts", () => {
  const d = (s) => civ(s);
  assert.equal(addCalendarDays(d("2026-10-03"), 1.5), null);
  assert.equal(addCalendarDays(d("2026-10-03"), Number.NaN), null);
  assert.equal(addCalendarDays(d("2026-10-03"), Number.POSITIVE_INFINITY), null);
  assert.equal(addCalendarDays(new Date(NaN), 1), null);
});

test("addCalendarDays rejects results outside the 1900-2100 civil range", () => {
  assert.equal(addCalendarDays(civ(`${CIVIL_MAX_YEAR}-12-31`), 1), null);
  assert.equal(addCalendarDays(civ(`${CIVIL_MIN_YEAR}-01-01`), -1), null);
  // Boundary stays valid at exactly the last/first allowed day.
  const atMax = addCalendarDays(civ(`${CIVIL_MAX_YEAR}-12-31`), 0);
  assert.ok(atMax);
  assert.equal(formatCivilDate(atMax), `${CIVIL_MAX_YEAR}-12-31`);
  const atMin = addCalendarDays(civ(`${CIVIL_MIN_YEAR}-01-01`), 0);
  assert.ok(atMin);
  assert.equal(formatCivilDate(atMin), `${CIVIL_MIN_YEAR}-01-01`);
});

test("round-trip: addCalendarDays is the inverse of differenceInDays across DST", () => {
  const d = (s) => civ(s);
  const start = d("2026-03-07");
  const offset = 400; // crosses a DST boundary and the year boundary
  const target = addCalendarDays(start, offset);
  assert.ok(target);
  assert.equal(differenceInDays(start, target), offset);
  assert.equal(differenceInDays(target, start), -offset);
});

test("date jump calculations count forward and backward from the base date", () => {
  const cases = [
    ["2026-10-10", 100, "2027-01-18"],
    ["2026-10-10", -100, "2026-07-02"],
    ["2024-03-01", -1, "2024-02-29"],
    ["2025-03-01", -1, "2025-02-28"],
    ["2026-01-31", 1, "2026-02-01"],
    ["2026-10-10", 0, "2026-10-10"],
  ];
  for (const [base, days, expected] of cases) {
    const start = civ(base);
    const result = addCalendarDays(start, days);
    assert.ok(result);
    assert.equal(formatCivilDate(result), expected);
    assert.equal(differenceInDays(start, result), days);
    assert.equal(formatCivilDate(start), base);
  }
});

test("date jump calculations allow the entire supported range but reject overflow", () => {
  const first = civ("1900-01-01");
  const last = civ("2100-12-31");
  const days = differenceInDays(first, last);
  assert.equal(formatCivilDate(addCalendarDays(first, days)), "2100-12-31");
  assert.equal(formatCivilDate(addCalendarDays(last, -days)), "1900-01-01");
  assert.equal(addCalendarDays(first, days + 1), null);
  assert.equal(addCalendarDays(last, -days - 1), null);
  assert.equal(addCalendarDays(first, Number.MAX_SAFE_INTEGER), null);
  assert.equal(addCalendarDays(last, -Number.MAX_SAFE_INTEGER), null);
});
