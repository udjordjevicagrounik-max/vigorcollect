import { createHash } from 'node:crypto';

/**
 * Tenant-local schedules (rule 26). "Every day at 06:00" means 06:00 in the tenant's time zone,
 * resolved to UTC per tenant and per day — so the UTC instant moves with DST. A run is
 * identified by tenant + LOCAL date: the same tenant never runs twice for one local day, however
 * often the clock ticks and whatever zones its companies are in.
 */

export type LocalMoment = { date: string; minutes: number };

const parts = (timezone: string, at: Date) => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
};

/** Local calendar date and minutes after local midnight of `at` in `timezone`. */
export function localMoment(timezone: string, at: Date): LocalMoment {
  return parts(timezone, at);
}

function parseTime(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`invalid local time "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Local wall-clock of `at` as if it were UTC (ms) — the zone offset is the difference. */
function wallClockMs(timezone: string, at: Date): number {
  const { date, minutes } = parts(timezone, at);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) + minutes * 60_000;
}

/**
 * UTC instant of `hhmm` local time on `localDate` in `timezone`. A local time that does not exist
 * (spring-forward gap) resolves to the first existing minute after it; an ambiguous one
 * (fall-back) to its first occurrence.
 */
export function localTimeToUtc(timezone: string, localDate: string, hhmm: string): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d) + parseTime(hhmm) * 60_000;
  // Offset before and after the naive instant; the earlier candidate wins (first occurrence).
  const candidates = [naive - 12 * 3_600_000, naive + 12 * 3_600_000]
    .map((probe) => naive - (wallClockMs(timezone, new Date(probe)) - probe))
    .filter((utc) => wallClockMs(timezone, new Date(utc)) === naive)
    .sort((x, z) => x - z);
  if (candidates[0] !== undefined) return new Date(candidates[0]);
  // Gap: the wall clock jumps over `hhmm` — take the first minute after the jump.
  let utc = naive - (wallClockMs(timezone, new Date(naive)) - naive);
  while (wallClockMs(timezone, new Date(utc)) < naive) utc += 60_000;
  while (wallClockMs(timezone, new Date(utc - 60_000)) >= naive) utc -= 60_000;
  return new Date(utc);
}

export type DailyRun = { localDate: string; dueAtUtc: Date; due: boolean };

/** Whether the daily `hhmm` run of `timezone` is due at `now`, for the current local date. */
export function dailyRun(timezone: string, now: Date, hhmm: string): DailyRun {
  const { date } = localMoment(timezone, now);
  const dueAtUtc = localTimeToUtc(timezone, date, hhmm);
  return { localDate: date, dueAtUtc, due: now.getTime() >= dueAtUtc.getTime() };
}

/** Deterministic job id (UUID shape) = idempotency key of one scheduled run. */
export function runId(job: string, tenantId: string, localDate: string): string {
  const h = createHash('sha256').update(`${job}|${tenantId}|${localDate}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
