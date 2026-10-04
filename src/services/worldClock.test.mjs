import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeOffsetMinutes, localizedClockDate } from "./worldClock.ts";

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
