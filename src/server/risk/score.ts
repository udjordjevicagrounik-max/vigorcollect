import { z } from 'zod';

/**
 * Risk score (task 4.3) — deterministic, explainable, integer arithmetic only (no float, no AI):
 *
 *   points(signal) ∈ 0..100 from fixed thresholds below;
 *   score = round(Σ points × weight / Σ weight) over the signals that HAVE a value;
 *   band  = red if score ≥ red threshold, yellow if ≥ yellow, else green (tenant settings).
 *
 * The explanation lists every signal — value, points, weight, its share of the score — and the
 * ones without a value with the reason they did not count. The same inputs always give the
 * same score and the same explanation (model version below).
 */

export const MODEL_VERSION = 'internal-v1';

export const SIGNALS = [
  'days_overdue',
  'exposure_vs_limit',
  'broken_promises_90d',
  'disputes_90d',
  'inactivity_days',
  'external_blocked',
] as const;
export type SignalType = (typeof SIGNALS)[number];

const weight = z.number().int().min(0).max(100).default(0);
export const weightsSchema = z.object({
  days_overdue: weight,
  exposure_vs_limit: weight,
  broken_promises_90d: weight,
  disputes_90d: weight,
  inactivity_days: weight,
  external_blocked: weight,
});
export type Weights = Record<SignalType, number>;

export type SignalValue = {
  type: SignalType;
  value: number | null;
  source: string;
  reason?: string;
};

/** Points 0..100 per signal; `value` is an integer (days, percent, count, 0/1). */
export function points(type: SignalType, value: number): number {
  const steps: Record<SignalType, [number, number][]> = {
    // [upper bound inclusive, points]
    days_overdue: [
      [0, 0],
      [30, 25],
      [60, 50],
      [90, 75],
    ],
    exposure_vs_limit: [
      [50, 0],
      [80, 30],
      [100, 60],
    ],
    broken_promises_90d: [
      [0, 0],
      [1, 50],
    ],
    disputes_90d: [
      [0, 0],
      [1, 50],
    ],
    inactivity_days: [
      [14, 0],
      [30, 30],
      [60, 60],
    ],
    external_blocked: [[0, 0]],
  };
  for (const [upTo, p] of steps[type]) if (value <= upTo) return p;
  return 100;
}

export type Contribution = {
  signal: SignalType;
  source: string;
  value: number | null;
  points: number | null;
  weight: number;
  /** Share of the score in hundredths of a point (integer): points × weight × 100 / Σ weight. */
  share: number | null;
  reason: string | null;
};

export type Explanation = {
  model: string;
  weights: Weights;
  thresholds: { yellow: number; red: number };
  totalWeight: number;
  contributions: Contribution[];
};

export function computeScore(
  signals: SignalValue[],
  weights: Weights,
  thresholds: { yellow: number; red: number },
): { score: number; band: 'green' | 'yellow' | 'red'; explanation: Explanation } {
  const counted = signals.filter((s) => s.value !== null && weights[s.type] > 0);
  const totalWeight = counted.reduce((sum, s) => sum + weights[s.type], 0);
  const weighted = counted.reduce(
    (sum, s) => sum + points(s.type, s.value ?? 0) * weights[s.type],
    0,
  );
  // Integer rounding half up: (2a + b) div 2b.
  const score =
    totalWeight === 0 ? 0 : Math.floor((2 * weighted + totalWeight) / (2 * totalWeight));
  const band = score >= thresholds.red ? 'red' : score >= thresholds.yellow ? 'yellow' : 'green';
  const contributions: Contribution[] = SIGNALS.map((type) => {
    const s = signals.find((x) => x.type === type);
    const weight = weights[type];
    if (!s || s.value === null)
      return {
        signal: type,
        source: s?.source ?? 'internal',
        value: null,
        points: null,
        weight,
        share: null,
        reason: s?.reason ?? 'not_available',
      };
    if (weight === 0)
      return {
        signal: type,
        source: s.source,
        value: s.value,
        points: points(type, s.value),
        weight,
        share: 0,
        reason: 'weight_zero',
      };
    const p = points(type, s.value);
    return {
      signal: type,
      source: s.source,
      value: s.value,
      points: p,
      weight,
      share: Math.floor((p * weight * 100) / totalWeight),
      reason: null,
    };
  });
  return {
    score,
    band,
    explanation: { model: MODEL_VERSION, weights, thresholds, totalWeight, contributions },
  };
}
