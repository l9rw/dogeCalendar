#!/usr/bin/env node
// measure-runtime.mjs
//
// P0 runtime performance sampling for dogeCalendar.
//
// Samples a target process *and its descendant tree* at a fixed cadence and
// prints a single JSON document to stdout. The document is self-describing:
// stderr carries diagnostics, stdout carries only JSON, so callers may
// redirect (`> out.json`) without contamination.
//
// Design constraints (do not regress):
//   - No third-party dependencies. Node built-ins only.
//   - `--pid` is REQUIRED. `--duration` and `--interval` are optional
//     (absent -> defaults). When the flags ARE present, a missing or
//     non-numeric value is rejected (exit 2) rather than silently falling
//     back to a default, so a dangling `--duration` can never produce NaN.
//   - macOS/Linux: `ps`. Windows: PowerShell `Get-CimInstance Win32_Process`.
//   - execFile calls are bounded by a timeout and maxBuffer so a wedged `ps`
//     or PowerShell cannot hang the sampler forever.
//   - Errors exit non-zero. The target exiting mid-run is reported, not fatal.
//   - This is a *process-tree resource sampler*. It deliberately does NOT
//     measure cold-start latency, wake-from-sleep cost, or network/disk I/O.
//   - The descendant tree of --pid is NOT necessarily the complete application
//     footprint: on macOS WKWebView/XPC helpers and daemons may be hosted by
//     launchd (pid 1) instead of being children of the sampled pid. The
//     `limitations` array states this explicitly.
//   - CPU is aggregated per-pid over the intersection of two consecutive
//     samples, so a child that exits between samples does not subtract from
//     the still-alive parent's CPU (the prior sum-of-tree delta clamped that
//     negative delta to zero and lost real parent CPU). Newly joined members
//     contribute zero on their first interval (conservative: no historical
//     CPU accumulated before they joined the tree).
//
// This script does not upload anything, track telemetry, or persist results.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 100;
const MAX_SAMPLES = 10000;
// Bound every spawned sampler so a stuck `ps`/PowerShell cannot block forever.
const SAMPLE_TIMEOUT_MS = 15000;
const SAMPLE_MAX_BUFFER = 64 * 1024 * 1024;

const SCHEMA = "dogeCalendar-runtime/1";

const LIMITATIONS = [
  "RSS (macOS/Linux) and working set (Windows) are summed per-process across the tree; shared memory pages between processes are counted more than once, so the total is an upper bound, not a unique resident footprint.",
  "The descendant subtree rooted at --pid is NOT a complete application resource accounting. On macOS, WKWebView content processes, XPC services and helper daemons may be hosted by launchd (pid 1) rather than as children of the sampled pid; on Windows, service hosts or broker processes may run separately. A 'complete tree' here is only the sampled pid's descendant subtree, not total app resources.",
  "Cold-start and wake-from-sleep latency are not measured; sampling begins only after the target pid is already alive.",
  "Network and disk I/O are not measured.",
  "CPU is reported as percent of a single logical core summed across the tree (100 = one core); it is derived from per-pid cumulative CPU-time deltas over the intersection of two consecutive samples, so the first sample has no CPU value.",
  "The process tree is recomputed each sample. Short-lived children that start and exit between two samples are missed entirely; a child that exits between samples is dropped from that interval's CPU delta rather than subtracted from the parent.",
  "PIDs can be reused by the OS between samples. Per-pid CPU deltas are clamped to non-negative to mitigate misattribution, but reuse can still attribute resources to the wrong process. Pids joining mid-run contribute zero on their first interval (no historical CPU is credited).",
  "Values reflect host scheduling and sampling granularity, not deterministic app performance.",
];

// ---- Argument parsing ------------------------------------------------------

function parseArgs(argv) {
  // Absent flags keep their defaults. A flag that IS present but lacks a
  // value records `undefined` plus a `*Provided` marker so validateArgs can
  // reject it (never silently default, never NaN).
  const args = {
    duration: DEFAULT_DURATION_MS,
    interval: DEFAULT_INTERVAL_MS,
    durationProvided: false,
    intervalProvided: false,
    pidProvided: false,
  };
  const rest = [];
  const takeValue = (i) => {
    const next = argv[i + 1];
    // Treat a missing token or another `--flag` as a missing value.
    if (next === undefined || next.startsWith("--")) return undefined;
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--pid") {
      args.pid = takeValue(i);
      i += args.pid === undefined ? 0 : 1;
      args.pidProvided = true;
    } else if (a === "--duration") {
      args.duration = takeValue(i);
      i += args.duration === undefined ? 0 : 1;
      args.durationProvided = true;
    } else if (a === "--interval") {
      args.interval = takeValue(i);
      i += args.interval === undefined ? 0 : 1;
      args.intervalProvided = true;
    } else if (a.startsWith("--pid=")) {
      args.pid = a.slice(6);
      args.pidProvided = true;
    } else if (a.startsWith("--duration=")) {
      args.duration = a.slice(11);
      args.durationProvided = true;
    } else if (a.startsWith("--interval=")) {
      args.interval = a.slice(11);
      args.intervalProvided = true;
    } else {
      rest.push(a);
    }
  }
  return { args, rest };
}

function printHelp(stream) {
  stream.write(
    [
      "Usage: node scripts/measure-runtime.mjs --pid <pid> [--duration ms] [--interval ms]",
      "",
      "Required:",
      "  --pid <pid>            Target process id to sample (with its descendant tree).",
      "",
      "Optional (absent -> default; present but missing/invalid value -> rejected):",
      "  --duration <ms>        Total sampling window in milliseconds.",
      `                         Default: ${DEFAULT_DURATION_MS}.`,
      "  --interval <ms>        Time between samples in milliseconds.",
      `                         Default: ${DEFAULT_INTERVAL_MS}. Min: ${MIN_INTERVAL_MS}.`,
      "                         Must be <= duration.",
      "  -h, --help             Show this help.",
      "",
      "Output: a single JSON document on stdout (diagnostics go to stderr).",
      "Exit codes: 0 ok; 2 bad arguments; 3 target missing/unreachable; 4 sampling error.",
      "",
      "NOTE: This samples the descendant subtree's RSS/working set and CPU only.",
      "It does NOT measure cold start, wake latency, or network/IO. The subtree is",
      "NOT a complete app footprint (XPC/launchd/helpers may be separate), and shared",
      "memory between processes is double-counted. See the output `limitations` array.",
      "",
    ].join("\n"),
  );
}

export function validateArgs(raw) {
  const errors = [];
  if (!raw.pidProvided) {
    errors.push("--pid is required");
  } else {
    const n = Number(raw.pid);
    if (raw.pid === undefined || !Number.isInteger(n) || n <= 0) {
      errors.push(`--pid must be a positive integer (got "${raw.pid}")`);
    }
  }
  let duration = DEFAULT_DURATION_MS;
  if (raw.durationProvided) {
    const n = Number(raw.duration);
    if (raw.duration === undefined || !Number.isFinite(n) || n <= 0) {
      errors.push(`--duration must be a positive number of ms (got "${raw.duration}")`);
    } else {
      duration = Math.round(n);
    }
  }
  let interval = DEFAULT_INTERVAL_MS;
  if (raw.intervalProvided) {
    const n = Number(raw.interval);
    if (raw.interval === undefined || !Number.isFinite(n) || n <= 0) {
      errors.push(`--interval must be a positive number of ms (got "${raw.interval}")`);
    } else {
      interval = Math.round(n);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (interval < MIN_INTERVAL_MS) {
    return {
      ok: false,
      errors: [
        `--interval must be >= ${MIN_INTERVAL_MS}ms to avoid runaway sampling (got ${interval})`,
      ],
    };
  }
  if (interval > duration) {
    return {
      ok: false,
      errors: [`--interval (${interval}) must be <= --duration (${duration})`],
    };
  }
  const pid = Number(raw.pid);
  const maxSamples = Math.min(MAX_SAMPLES, Math.floor(duration / interval) + 1);
  return { ok: true, pid, duration, interval, maxSamples };
}

// ---- Pure helpers (exported for unit tests) --------------------------------

// Parse `ps` cumulative CPU time formats: "M:SS.cc", "MM:SS", "HH:MM:SS",
// "D-HH:MM:SS", "D-HH:MM:SS.cc". Returns seconds, or null if unparseable.
export function parsePsCpuTime(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  const dashIdx = s.indexOf("-");
  let days = 0;
  let rest = s;
  if (dashIdx > 0) {
    const dayPart = s.slice(0, dashIdx);
    const d = Number(dayPart);
    if (!Number.isFinite(d)) return null;
    days = d;
    rest = s.slice(dashIdx + 1);
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let h = 0;
  let m = 0;
  let sec = 0;
  if (parts.length === 2) {
    m = nums[0];
    sec = nums[1];
  } else {
    h = nums[0];
    m = nums[1];
    sec = nums[2];
  }
  return days * 86400 + h * 3600 + m * 60 + sec;
}

// Convert Windows 100-ns CPU time units to seconds.
export function windowsTicksToSeconds(ticks) {
  const n = Number(ticks);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n / 1e7;
}

// Given a flat list of {pid, ppid, ...} processes and a root pid, return the
// set of pids in the subtree rooted at pid (inclusive). Robust to cycles.
export function buildProcessTree(processes, rootPid) {
  const byPid = new Map();
  for (const p of processes) {
    if (p && Number.isFinite(Number(p.pid))) byPid.set(Number(p.pid), p);
  }
  const result = new Set();
  if (!byPid.has(rootPid)) return result;
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    result.add(cur);
    for (const p of processes) {
      if (Number(p.ppid) === cur && !seen.has(Number(p.pid))) {
        queue.push(Number(p.pid));
      }
    }
  }
  return result;
}

// Reduce a sample list into min/max/mean/last numeric stats.
export function summarize(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) {
    return { count: 0, min: null, max: null, mean: null, last: null };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of nums) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    count: nums.length,
    min,
    max,
    mean: sum / nums.length,
    last: nums[nums.length - 1],
  };
}

// Compute tree CPU percent (of one core) as the sum of per-pid cumulative-CPU
// deltas over the *intersection* of two consecutive samples.
//
//   prev, cur: Map<pid, cumulativeCpuSeconds>
//   dtSeconds: wall time between the two samples
//
// A pid present only in `cur` (joined this interval) contributes zero: its
// historical CPU accumulated before joining is intentionally not credited.
// A pid present only in `prev` (exited) is dropped entirely, so it never
// subtracts from a still-alive parent's delta. Per-pid deltas are clamped to
// non-negative to survive PID reuse / monotonicity jitter.
//
// Returns null when there is no previous sample, no current members, or dt<=0.
export function computeTreeCpuDelta(prevMap, curMap, dtSeconds) {
  if (!(curMap instanceof Map) || curMap.size === 0) return null;
  if (!(prevMap instanceof Map) || prevMap.size === 0) return null;
  if (typeof dtSeconds !== "number" || !Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return null;
  }
  let sum = 0;
  for (const [pid, curCpu] of curMap) {
    const prevCpu = prevMap.get(pid);
    if (prevCpu === undefined) continue; // joined: conservative, no history
    const d = curCpu - prevCpu;
    if (d > 0) sum += d; // clamp negative (PID reuse / jitter)
  }
  return (sum / dtSeconds) * 100;
}

// ---- Platform samplers -----------------------------------------------------

function samplerExecOpts() {
  return { timeout: SAMPLE_TIMEOUT_MS, maxBuffer: SAMPLE_MAX_BUFFER };
}

async function runPs() {
  // -A: all processes. Trailing '=' suppresses the header row on each field.
  // We intentionally do NOT collect command/comm: it is unnecessary for tree
  // walking (ppid suffices), adds output volume, and leaks command lines.
  // rss is in kilobytes. time is cumulative CPU time for the process.
  const { stdout } = await execFileAsync(
    "ps",
    ["-A", "-o", "pid=,ppid=,rss=,time="],
    samplerExecOpts(),
  );
  const procs = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    // Four whitespace-separated tokens: pid ppid rss time.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      cpuSeconds: parsePsCpuTime(m[4]),
    });
  }
  return procs;
}

async function runPowerShell() {
  // Get-CimInstance returns WorkingSetSize (bytes) plus User/Kernel CPU time
  // in 100-ns ticks. ConvertTo-Json -Compress keeps stdout compact. No
  // CommandLine is selected (privacy + output volume).
  const script =
    "$ErrorActionPreference='Stop';" +
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    "Get-CimInstance -ClassName Win32_Process | ForEach-Object {" +
    "[pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; " +
    "WorkingSetSize=$_.WorkingSetSize; UserModeTime=$_.UserModeTime; " +
    "KernelModeTime=$_.KernelModeTime } } | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    samplerExecOpts(),
  );
  const text = stdout.trim();
  if (text === "") return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`PowerShell returned non-JSON output: ${e.message}`);
  }
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((d) => ({
    pid: Number(d.ProcessId),
    ppid: Number(d.ParentProcessId),
    rssBytes: Number(d.WorkingSetSize) || 0,
    cpuSeconds:
      windowsTicksToSeconds(Number(d.UserModeTime)) +
      windowsTicksToSeconds(Number(d.KernelModeTime)),
  }));
}

async function sampleOnce(rootPid) {
  const isWindows = platform() === "win32";
  const procs = isWindows ? await runPowerShell() : await runPs();
  const tree = buildProcessTree(procs, rootPid);
  if (tree.size === 0) {
    return { treeSize: 0, rssBytes: 0, cpuMap: new Map(), alive: false, members: [] };
  }
  let rss = 0;
  const cpuMap = new Map();
  const members = [];
  for (const p of procs) {
    if (tree.has(Number(p.pid))) {
      const rssBytes = p.rssBytes || 0;
      rss += rssBytes;
      // Store the most recent cumulative CPU seen for this pid; null/NaN -> 0
      // keeps deltas finite rather than propagating NaN.
      const cpu = Number.isFinite(p.cpuSeconds) ? p.cpuSeconds : 0;
      cpuMap.set(p.pid, cpu);
      members.push({ pid: p.pid, rssBytes });
    }
  }
  return { treeSize: tree.size, rssBytes: rss, cpuMap, alive: true, members };
}

// ---- Sampling loop ---------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sampleLoop({ pid, duration, interval, maxSamples }) {
  const samples = [];
  const start = Date.now();
  let prevMap = null;
  let prevT = null;
  let targetExited = false;
  let lastError = null;

  const t0 = Date.now();
  let first;
  try {
    first = await sampleOnce(pid);
  } catch (e) {
    lastError = e.message;
    return { samples, targetExited: false, error: lastError };
  }
  if (!first.alive) {
    targetExited = true;
    return { samples, targetExited, error: null };
  }
  prevMap = first.cpuMap;
  prevT = t0;
  samples.push({
    t: 0,
    pid,
    treeSize: first.treeSize,
    rssBytes: first.rssBytes,
    cpuPercent: null,
    members: first.members,
  });

  while (samples.length < maxSamples) {
    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= duration) break;
    const nextDue = (samples.length - 1) * interval;
    const wait = Math.max(0, nextDue - elapsed + interval);
    await sleep(wait);

    const tNow = Date.now();
    let s;
    try {
      s = await sampleOnce(pid);
    } catch (e) {
      lastError = e.message;
      break;
    }
    if (!s.alive) {
      targetExited = true;
      break;
    }
    const dt = (tNow - prevT) / 1000;
    const cpuPercent = computeTreeCpuDelta(prevMap, s.cpuMap, dt);
    samples.push({
      t: tNow - t0,
      pid,
      treeSize: s.treeSize,
      rssBytes: s.rssBytes,
      cpuPercent,
      members: s.members,
    });
    prevMap = s.cpuMap;
    prevT = tNow;
  }

  return { samples, targetExited, error: lastError };
}

// ---- CLI entry -------------------------------------------------------------

async function main() {
  const { args, rest } = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp(process.stdout);
    return 0;
  }

  if (rest.length > 0) {
    process.stderr.write(`error: unknown argument(s): ${rest.join(" ")}\n`);
    printHelp(process.stderr);
    return 2;
  }

  const v = validateArgs(args);
  if (!v.ok) {
    for (const e of v.errors) process.stderr.write(`error: ${e}\n`);
    printHelp(process.stderr);
    return 2;
  }

  const cfg = { pid: v.pid, duration: v.duration, interval: v.interval, maxSamples: v.maxSamples };
  process.stderr.write(
    `sampling pid=${cfg.pid} duration=${cfg.duration}ms interval=${cfg.interval}ms platform=${platform()}\n`,
  );

  const { samples, targetExited, error } = await sampleLoop(cfg);

  if (samples.length === 0) {
    process.stderr.write(
      error
        ? `error: sampling failed before any sample: ${error}\n`
        : `error: target pid ${cfg.pid} not found or already exited before first sample\n`,
    );
    return error ? 4 : 3;
  }

  const rssValues = samples.map((s) => s.rssBytes);
  const cpuValues = samples.map((s) => s.cpuPercent);
  const treeSizes = samples.map((s) => s.treeSize);

  const document = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    platform: platform(),
    config: {
      pid: cfg.pid,
      durationMs: cfg.duration,
      intervalMs: cfg.interval,
      maxSamples: cfg.maxSamples,
    },
    limitations: LIMITATIONS,
    targetExited,
    error,
    samples,
    summary: {
      sampleCount: samples.length,
      rssBytes: summarize(rssValues),
      cpuPercent: summarize(cpuValues),
      treeSize: summarize(treeSizes),
    },
  };

  process.stdout.write(JSON.stringify(document, null, 2) + "\n");

  if (targetExited) {
    process.stderr.write(`note: target pid ${cfg.pid} exited during sampling; ${samples.length} sample(s) collected.\n`);
  }
  if (error) {
    process.stderr.write(`warning: sampling stopped early due to error: ${error}\n`);
    return 4;
  }
  return 0;
}

// Only run CLI when invoked directly, not when imported by tests.
// Use pathToFileURL(resolve(...)) so Windows drive paths (C:\\...) form a valid
// file: URL for comparison against import.meta.url.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
