-- 031_attention_view_down.sql — back to the 016 definition (same columns).
CREATE OR REPLACE VIEW attention_customer_items WITH (security_invoker = true) AS
SELECT 'promise_broken'::text AS kind, pr.customer_id, pr.id AS ref_id, pr.case_id,
       pr.evaluated_at AS since, pr.amount::numeric(18,2) AS amount, pr.currency, 2 AS severity
FROM promises pr
WHERE pr.status = 'broken' AND pr.evaluated_at > now() - interval '30 days'
  AND NOT EXISTS (SELECT 1 FROM promises later WHERE later.customer_id = pr.customer_id
                    AND later.created_at > pr.evaluated_at AND later.status IN ('pending', 'fulfilled'))
UNION ALL
SELECT 'no_activity', x.customer_id, x.customer_id, NULL::uuid, x.last_activity, x.overdue::numeric(18,2), x.currency, 1
FROM (
  SELECT p.customer_id, max(a.occurred_at) AS last_activity, sum(p.open_reporting) AS overdue,
         max(p.reporting_currency) AS currency, max(ts.attention_no_activity_days) AS days
  FROM invoice_positions p
  CROSS JOIN tenant_settings ts
  LEFT JOIN activities a ON a.customer_id = p.customer_id
  WHERE p.is_overdue
  GROUP BY p.customer_id
) x
WHERE coalesce(x.last_activity, '-infinity') < now() - make_interval(days => x.days)
UNION ALL
SELECT 'large_overdue', y.customer_id, y.invoice_id, NULL::uuid, NULL::timestamptz, y.open_reporting::numeric(18,2),
       y.reporting_currency, 2
FROM (
  SELECT p.*, ts.attention_large_overdue AS threshold,
         row_number() OVER (ORDER BY p.open_reporting DESC NULLS LAST) AS rank
  FROM invoice_positions p CROSS JOIN tenant_settings ts
  WHERE p.is_overdue
) y
WHERE (y.threshold IS NOT NULL AND y.open_reporting >= y.threshold) OR (y.threshold IS NULL AND y.rank <= 5)
UNION ALL
SELECT 'unassigned_case', k.customer_id, k.id, k.id, k.opened_at, NULL::numeric(18,2), NULL::char(3), 1
FROM collection_cases k
WHERE k.status = 'open' AND k.owner_user_id IS NULL;
