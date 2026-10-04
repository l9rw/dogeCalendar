import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePsCpuTime,
  windowsTicksToSeconds,
  buildProcessTree,
  summarize,
  validateArgs,
  computeTreeCpuDelta,
} from "./measure-runtime.mjs";

test("parsePsCpuTime handles common ps time formats", () => {
  assert.equal(parsePsCpuTime("0:00.12"), 0.12);
  assert.equal(parsePsCpuTime("1:23"), 83);
  assert.equal(parsePsCpuTime("12:34.56"), 754.56);
  assert.equal(parsePsCpuTime("1:02:03"), 3723);
  assert.equal(parsePsCpuTime("1-02:03:04"), 93784);
  assert.equal(parsePsCpuTime("1-00:00:00.50"), 86400.5);
  assert.equal(parsePsCpuTime(""), null);
  assert.equal(parsePsCpuTime("not a time"), null);
  assert.equal(parsePsCpuTime(null), null);
});

test("windowsTicksToSeconds converts 100ns ticks", () => {
  assert.equal(windowsTicksToSeconds(1e7), 1);
  assert.equal(windowsTicksToSeconds(0), 0);
  assert.equal(windowsTicksToSeconds(-5), 0);
  assert.equal(windowsTicksToSeconds("abc"), 0);
});

test("buildProcessTree walks descendants and tolerates cycles", () => {
  const procs = [
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 101 },
    { pid: 103, ppid: 999 },
    { pid: 104, ppid: 100 },
  ];
  const tree = buildProcessTree(procs, 100);
  assert.deepEqual([...tree].sort((a, b) => a - b), [100, 101, 102, 104]);

  assert.equal(buildProcessTree(procs, 777).size, 0);

  const cyclic = [
    { pid: 1, ppid: 2 },
    { pid: 2, ppid: 1 },
  ];
  const t = buildProcessTree(cyclic, 1);
  assert.deepEqual([...t].sort((a, b) => a - b), [1, 2]);
});

test("summarize reduces numeric series, ignoring non-numbers", () => {
  const s = summarize([10, 20, null, 30, undefined]);
  assert.equal(s.count, 3);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.mean, 20);
  assert.equal(s.last, 30);
  assert.deepEqual(summarize([]), { count: 0, min: null, max: null, mean: null, last: null });
});

// ---- Per-pid CPU delta aggregation -----------------------------------------

function mapFrom(entries) {
  return new Map(entries);
}

test("computeTreeCpuDelta: child exit does not erase the parent's CPU", () => {
  // Parent pid=1 gains 1 core-second; child pid=2 exits (present before, gone after).
  // The old sum-of-tree delta would compute (11) - (10+5) = -4 and clamp to 0,
  // hiding the parent's real 1s of CPU. Per-pid intersection keeps it.
  const prev = mapFrom([[1, 10], [2, 5]]);
  const cur = mapFrom([[1, 11]]);
  assert.equal(computeTreeCpuDelta(prev, cur, 1), 100);
});

test("computeTreeCpuDelta: newly joined members contribute zero (no history)", () => {
  // Child pid=2 joins this interval with 100 core-seconds of pre-existing CPU.
  // That history must NOT be credited. Only the parent's delta counts.
  const prev = mapFrom([[1, 10]]);
  const cur = mapFrom([[1, 11], [2, 100]]);
  assert.equal(computeTreeCpuDelta(prev, cur, 1), 100);
});

test("computeTreeCpuDelta: PID reuse (cumulative drops) is clamped per-pid", () => {
  // pid=2 reused by a fresh process: cumulative drops from 5 to 3 -> negative
  // delta is dropped, not subtracted. pid=1 gains 2 -> 200%.
  const prev = mapFrom([[1, 10], [2, 5]]);
  const cur = mapFrom([[1, 12], [2, 3]]);
  assert.equal(computeTreeCpuDelta(prev, cur, 1), 200);
});

test("computeTreeCpuDelta: sums deltas across the shared intersection", () => {
  const prev = mapFrom([[1, 10], [2, 4]]);
  const cur = mapFrom([[1, 11], [2, 7]]);
  // deltas: 1 + 3 = 4 core-seconds over 2s -> 200%
  assert.equal(computeTreeCpuDelta(prev, cur, 2), 200);
});

test("computeTreeCpuDelta: returns null without a previous sample or bad dt", () => {
  const cur = mapFrom([[1, 5]]);
  assert.equal(computeTreeCpuDelta(null, cur, 1), null);
  assert.equal(computeTreeCpuDelta(new Map(), cur, 1), null);
  assert.equal(computeTreeCpuDelta(mapFrom([[1, 5]]), new Map(), 1), null);
  assert.equal(computeTreeCpuDelta(mapFrom([[1, 5]]), cur, 0), null);
  assert.equal(computeTreeCpuDelta(mapFrom([[1, 5]]), cur, -1), null);
  assert.equal(computeTreeCpuDelta(mapFrom([[1, 5]]), cur, NaN), null);
});

// ---- Argument validation ---------------------------------------------------

function mk(args) {
  // Mimic parseArgs output shape for validateArgs.
  return { durationProvided: false, intervalProvided: false, pidProvided: false, ...args };
}

test("validateArgs: --pid is required", () => {
  const r = validateArgs(mk({ duration: 1000, interval: 1000 }));
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("--pid is required")));
});

test("validateArgs: bad/zero/negative pid rejected", () => {
  for (const pid of ["abc", "0", "-1", undefined]) {
    const r = validateArgs(mk({ pid, pidProvided: true, duration: 1000, interval: 1000 }));
    assert.ok(!r.ok, `pid "${pid}" should be rejected`);
    assert.ok(r.errors.some((e) => e.includes("positive integer")));
  }
});

test("validateArgs: absent duration/interval fall back to defaults (still valid)", () => {
  const r = validateArgs(mk({ pid: "42", pidProvided: true }));
  assert.ok(r.ok);
  assert.equal(r.duration, 5000);
  assert.equal(r.interval, 1000);
});

test("validateArgs: dangling --duration/--interval (missing value) rejected", () => {
  // A present flag whose value is undefined must NOT silently default -> NaN.
  const d = validateArgs(mk({ pid: "1", pidProvided: true, duration: undefined, durationProvided: true, interval: 1000, intervalProvided: false }));
  assert.ok(!d.ok);
  assert.ok(d.errors.some((e) => e.includes("--duration must be a positive number")));

  const i = validateArgs(mk({ pid: "1", pidProvided: true, duration: 1000, durationProvided: false, interval: undefined, intervalProvided: true }));
  assert.ok(!i.ok);
  assert.ok(i.errors.some((e) => e.includes("--interval must be a positive number")));
});

test("validateArgs: non-numeric provided values rejected", () => {
  const d = validateArgs(mk({ pid: "1", pidProvided: true, duration: "x", durationProvided: true, interval: 1000, intervalProvided: false }));
  assert.ok(!d.ok);
});

test("validateArgs: interval boundaries enforced", () => {
  const tooSmall = validateArgs(mk({ pid: "1", pidProvided: true, duration: 1000, durationProvided: true, interval: 10, intervalProvided: true }));
  assert.ok(!tooSmall.ok);
  assert.ok(tooSmall.errors.some((e) => e.includes(">= 100")));

  const gt = validateArgs(mk({ pid: "1", pidProvided: true, duration: 200, durationProvided: true, interval: 1000, intervalProvided: true }));
  assert.ok(!gt.ok);
  assert.ok(gt.errors.some((e) => e.includes("<= --duration")));
});

test("validateArgs: valid args compute maxSamples", () => {
  const r = validateArgs(mk({ pid: "42", pidProvided: true, duration: 2000, durationProvided: true, interval: 500, intervalProvided: true }));
  assert.ok(r.ok);
  assert.equal(r.pid, 42);
  assert.equal(r.duration, 2000);
  assert.equal(r.interval, 500);
  assert.equal(r.maxSamples, 5);

  const one = validateArgs(mk({ pid: "1", pidProvided: true, duration: 1000, durationProvided: true, interval: 1000, intervalProvided: true }));
  assert.ok(one.ok);
  assert.equal(one.maxSamples, 2);
});
