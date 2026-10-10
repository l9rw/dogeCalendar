import assert from "node:assert/strict";
import { test } from "node:test";
import { countdownTarget, localDateTimeValue, remainingTime, validBarkServer } from "./countdown.ts";

test("countdown converts local input to a UTC instant and round trips", () => {
  const date = new Date(2030, 9, 10, 14, 30);
  assert.equal(localDateTimeValue(date), "2030-10-10T14:30");
  assert.equal(countdownTarget("2030-10-10T14:30", 0), date.getTime() / 1000);
});

test("countdown rejects empty, malformed, impossible and non-future times", () => {
  for (const value of ["", "bad", "2030-02-30T14:30", "2030-13-01T14:30", "2030-01-01T24:30", "2030-01-01", "2030-01-01T12:00Z"]) {
    assert.equal(countdownTarget(value, 0), null, value);
  }
  const value = "2030-10-10T14:30";
  const instant = new Date(value).getTime();
  assert.equal(countdownTarget(value, instant), null);
  assert.equal(countdownTarget(value, instant + 1), null);
  assert.equal(countdownTarget(value, instant - 1), instant / 1000);
});

test("remaining countdown does not go negative and supports more than 24 hours", () => {
  assert.equal(remainingTime(60, 0), "00:01:00");
  assert.equal(remainingTime(60, 0.1), "00:01:00");
  assert.equal(remainingTime(60, 59.5), "00:00:01");
  assert.equal(remainingTime(60, 60), "00:00:00");
  assert.equal(remainingTime(60, 61), "00:00:00");
  assert.equal(remainingTime(90061, 0), "25:01:01");
});

test("DST gaps are rejected and repeated times consistently use earlier occurrence", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(countdownTarget("2030-03-10T02:30", 0), null);
    assert.equal(countdownTarget("2030-11-03T01:30", 0), Date.parse("2030-11-03T05:30:00Z") / 1000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("Bark accepts HTTPS base servers only without credentials or parameters", () => {
  for (const value of ["https://api.day.app", " https://example.com:8443/bark/ "]) assert.equal(validBarkServer(value), true);
  for (const value of ["http://api.day.app", "bad", "https://user:secret@example.com", "https://api.day.app/?key=secret", "https://api.day.app/#secret"]) assert.equal(validBarkServer(value), false, value);
});
