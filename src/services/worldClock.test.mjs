import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeOffsetMinutes, localizedClockDate, isClockDaytime } from "./worldClock.ts";

test("offset differences include fractional timezones and local DST", () => {
  assert.equal(relativeOffsetMinutes(480, -480), 0);
  assert.equal(relativeOffsetMinutes(330, -480), -150);
  assert.equal(relativeOffsetMinutes(-240, 240), 0);
  assert.equal(relativeOffsetMinutes(-300, 240), -60);
});

test("civil clock dates do not change with UTC parsing", () => {
  assert.match(localizedClockDate("2026-10-03", "en-US"), /Oct.*3|3.*Oct/);
  assert.equal(localizedClockDate("invalid", "en-US"), "invalid");
});

test("day illustration switches at 06:00 and 18:00 local clock time", () => {
  for (const time of ["00:00", "05:59", "18:00", "23:59"]) {
    assert.equal(isClockDaytime(time), false, time);
  }
  for (const time of ["06:00", "12:00", "17:59"]) {
    assert.equal(isClockDaytime(time), true, time);
  }
});
