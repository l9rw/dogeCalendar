// datetime-local values use the current system time zone, not UTC.
export function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function countdownTarget(value: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  // Reject impossible dates and local times skipped by daylight saving.
  if (!Number.isFinite(date.getTime()) || localDateTimeValue(date) !== value || date.getTime() <= now) return null;
  return Math.floor(date.getTime() / 1000);
}

export function remainingTime(target: number, now: number): string {
  const seconds = Math.max(0, Math.ceil(target - now));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function validBarkServer(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
