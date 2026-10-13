import { describe, expect, it } from 'vitest';
import { delta, shares, sumDecimals } from '@/lib/chart-scale';

// 6.2: chart geometry from decimal strings — integers on the way, never money through a float.
describe('chart scale', () => {
  it('shares of the largest value; negatives and garbage are 0', () => {
    expect(shares(['50.00', '100.00', '-5', 'x', null])).toEqual([0.5, 1, 0, 0, 0]);
    expect(shares(['0', '0'])).toEqual([0, 0]);
  });
  it('sums decimal strings exactly', () => {
    expect(sumDecimals(['0.10', '0.20', '1234567890123.45'])).toBe('1234567890123.75');
    expect(sumDecimals(['-1.05', '0.05'])).toBe('-1.00');
  });
  it('delta and percent change', () => {
    expect(delta('110.00', '100.00')).toEqual({ diff: '10.00', percent: '10.0' });
    expect(delta('90', '100')).toEqual({ diff: '-10.00', percent: '-10.0' });
    expect(delta('5', '0')).toEqual({ diff: '5.00', percent: null });
  });
});
