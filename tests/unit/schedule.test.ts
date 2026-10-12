import { describe, expect, it } from 'vitest';
import { dailyRun, localMoment, localTimeToUtc, runId } from '@/server/jobs/schedule';

// Rule 26: "06:00" is the tenant's local time, resolved to UTC per day (DST moves the instant).

describe('localTimeToUtc', () => {
  it('Europe/Belgrade 06:00: 04:00Z in summer, 05:00Z in winter', () => {
    expect(localTimeToUtc('Europe/Belgrade', '2026-07-01', '06:00').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(localTimeToUtc('Europe/Belgrade', '2026-12-01', '06:00').toISOString()).toBe(
      '2026-12-01T05:00:00.000Z',
    );
  });

  it('DST change days: spring forward (2026-03-29) and fall back (2026-10-25)', () => {
    expect(localTimeToUtc('Europe/Belgrade', '2026-03-29', '06:00').toISOString()).toBe(
      '2026-03-29T04:00:00.000Z',
    );
    expect(localTimeToUtc('Europe/Belgrade', '2026-10-25', '06:00').toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    );
  });

  it('a local time inside the spring-forward gap runs at the first minute after it', () => {
    // 02:30 does not exist in Belgrade on 2026-03-29 (02:00 → 03:00).
    expect(localTimeToUtc('Europe/Belgrade', '2026-03-29', '02:30').toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('an ambiguous fall-back time resolves to its first occurrence', () => {
    // 02:30 happens twice in Belgrade on 2026-10-25 (00:30Z and 01:30Z).
    expect(localTimeToUtc('Europe/Belgrade', '2026-10-25', '02:30').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('other hemisphere and half-hour zones', () => {
    expect(localTimeToUtc('America/New_York', '2026-11-01', '06:00').toISOString()).toBe(
      '2026-11-01T11:00:00.000Z',
    );
    expect(localTimeToUtc('Asia/Kolkata', '2026-03-29', '06:00').toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
  });
});

describe('dailyRun and the run key (tenant + LOCAL date)', () => {
  it('the local date, not the UTC date, decides the day', () => {
    // 23:30Z on 2026-06-30 is already 2026-07-01 in Tokyo and still 2026-06-30 in New York.
    const at = new Date('2026-06-30T23:30:00Z');
    expect(localMoment('Asia/Tokyo', at).date).toBe('2026-07-01');
    expect(localMoment('America/New_York', at).date).toBe('2026-06-30');
  });

  it('not due before 06:00 local, due after; the run id is stable within the local day', () => {
    const before = dailyRun('Europe/Belgrade', new Date('2026-10-25T04:59:00Z'), '06:00');
    const after = dailyRun('Europe/Belgrade', new Date('2026-10-25T05:00:00Z'), '06:00');
    const later = dailyRun('Europe/Belgrade', new Date('2026-10-25T21:00:00Z'), '06:00');
    expect([before.due, after.due, later.due]).toEqual([false, true, true]);
    expect(runId('daily', 't1', after.localDate)).toBe(runId('daily', 't1', later.localDate));
    expect(runId('daily', 't1', '2026-10-25')).not.toBe(runId('daily', 't1', '2026-10-26'));
    expect(runId('daily', 't1', '2026-10-25')).not.toBe(runId('daily', 't2', '2026-10-25'));
    expect(runId('daily', 't1', '2026-10-25')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
