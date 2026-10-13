import type { Queryable } from '@/server/crypto/subject-keys';
import type { SignalValue } from './score';

/**
 * Internal signals (task 4.3) from the tenant's own data, as integers — computed in SQL from
 * numeric amounts (rule 18: no float in code), all "days" in the company's zone (rule 26):
 *   days_overdue        — oldest overdue open invoice (0 when nothing is overdue)
 *   exposure_vs_limit   — open amount / credit limit in percent (only with a limit in the
 *                         reporting currency; otherwise not available)
 *   broken_promises_90d — promises evaluated as broken in the last 90 days
 *   disputes_90d        — "dispute raised" activities in 90 days + open cases in stage dispute
 *   inactivity_days     — days since the last activity, only while something is overdue
 */
export async function internalSignals(db: Queryable, customerId: string): Promise<SignalValue[]> {
  const { rows } = await db.query<{
    days_overdue: number | null;
    exposure_pct: number | null;
    has_limit: boolean;
    broken: number;
    disputes: number;
    inactive: number | null;
    any_overdue: boolean;
  }>(
    `SELECT agg.days AS days_overdue,
            CASE WHEN c.credit_limit IS NOT NULL AND c.credit_limit_currency = ts.default_currency
                 THEN round(coalesce(agg.open, 0) * 100 / c.credit_limit)::int END AS exposure_pct,
            c.credit_limit IS NOT NULL AS has_limit,
            (SELECT count(*)::int FROM promises pr WHERE pr.customer_id = c.id AND pr.status = 'broken'
               AND pr.evaluated_at > now() - interval '90 days') AS broken,
            (SELECT count(*)::int FROM activities a WHERE a.customer_id = c.id AND a.outcome_code = 'dispute_raised'
               AND a.occurred_at > now() - interval '90 days')
            + (SELECT count(*)::int FROM collection_cases k WHERE k.customer_id = c.id AND k.status = 'open'
               AND k.stage_code = 'dispute') AS disputes,
            (SELECT (agg.today - max(a.occurred_at AT TIME ZONE agg.zone)::date)::int
             FROM activities a WHERE a.customer_id = c.id) AS inactive,
            coalesce(agg.days, 0) > 0 AS any_overdue
     FROM customers c
     CROSS JOIN tenant_settings ts
     LEFT JOIN LATERAL (
       SELECT max(p.days_overdue) FILTER (WHERE p.is_overdue) AS days,
              sum(p.open_reporting) FILTER (WHERE p.is_open) AS open,
              max(p.local_today) AS today,
              coalesce((SELECT le.timezone FROM tenant_companies tc JOIN legal_entities le ON le.id = tc.legal_entity_id
                        ORDER BY tc.is_default DESC, tc.created_at LIMIT 1), 'UTC') AS zone
       FROM invoice_positions p WHERE p.customer_id = c.id) agg ON true
     WHERE c.id = $1`,
    [customerId],
  );
  const r = rows[0];
  if (!r) return [];
  return [
    { type: 'days_overdue', value: r.days_overdue ?? 0, source: 'internal' },
    {
      type: 'exposure_vs_limit',
      value: r.exposure_pct,
      source: 'internal',
      ...(r.exposure_pct === null
        ? { reason: r.has_limit ? 'limit_other_currency' : 'no_credit_limit' }
        : {}),
    },
    { type: 'broken_promises_90d', value: r.broken, source: 'internal' },
    { type: 'disputes_90d', value: r.disputes, source: 'internal' },
    {
      type: 'inactivity_days',
      // Inactivity matters only while money is overdue; never contacted = treated as > 60 days.
      value: r.any_overdue ? (r.inactive ?? 999) : 0,
      source: 'internal',
    },
  ];
}
