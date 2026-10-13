import { describe, expect, it } from 'vitest';
import { computeScore, points, type SignalValue, type Weights } from '@/server/risk/score';

const W: Weights = {
  days_overdue: 35,
  exposure_vs_limit: 20,
  broken_promises_90d: 20,
  disputes_90d: 15,
  inactivity_days: 10,
  external_blocked: 30,
};
const T = { yellow: 35, red: 65 };
const sig = (type: SignalValue['type'], value: number | null): SignalValue => ({
  type,
  value,
  source: 'internal',
});

describe('risk score (4.3): deterministic, explained, integer', () => {
  it('thresholds give fixed points', () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map((d) => points('days_overdue', d))).toEqual([
      0, 25, 25, 50, 50, 75, 75, 100,
    ]);
    expect(points('external_blocked', 1)).toBe(100);
  });

  it('same inputs → same score and explanation; missing values do not count', () => {
    const s = [
      sig('days_overdue', 45),
      sig('exposure_vs_limit', null),
      sig('broken_promises_90d', 1),
      sig('disputes_90d', 0),
      sig('inactivity_days', 70),
    ];
    const a = computeScore(s, W, T);
    const b = computeScore(s, W, T);
    expect(a).toEqual(b);
    // (50·35 + 50·20 + 0·15 + 100·10) / 80 = 46.875 → 47
    expect(a.score).toBe(47);
    expect(a.band).toBe('yellow');
    expect(a.explanation.totalWeight).toBe(80);
    const exposure = a.explanation.contributions.find((c) => c.signal === 'exposure_vs_limit');
    expect(exposure).toMatchObject({ value: null, share: null });
    const shares = a.explanation.contributions.reduce((n, c) => n + (c.share ?? 0), 0);
    expect(Math.abs(shares - a.score * 100)).toBeLessThanOrEqual(100);
  });

  it('weights change the score; no data at all = 0 green', () => {
    const s = [sig('days_overdue', 100), sig('disputes_90d', 0)];
    expect(computeScore(s, W, T).score).toBe(70);
    expect(computeScore(s, { ...W, disputes_90d: 85 }, T).score).toBe(29);
    expect(computeScore([], W, T)).toMatchObject({ score: 0, band: 'green' });
  });
});
