-- 031_attention_view_up.sql — Sprint 6.5 (performance check, 1.000 customers / 20.000 invoices).
-- Protected (rule 13). CREATE OR REPLACE of one view, same columns — nothing dropped or renamed.
--
-- 1. Bug: "no_activity" joined activities BEFORE grouping, so a customer's overdue amount was
--    multiplied by the number of their activities. Activities are now aggregated on their own.
-- 2. One pass: the overdue positions (fx per row is the expensive part) are read once (CTE) for
--    both "no_activity" and "large_overdue" — the attention list took ~450 ms at 20.000 invoices.

CREATE OR REPLACE VIEW attention_customer_items WITH (security_invoker = true) AS
WITH overdue AS (
  SELECT p.invoice_id, p.customer_id, p.open_reporting, p.reporting_currency
  FROM invoice_positions p
  WHERE p.is_overdue
)
SELECT 'promise_broken'::text AS kind, pr.customer_id, pr.id AS ref_id, pr.case_id,
       pr.evaluated_at AS since, pr.amount::numeric(18,2) AS amount, pr.currency, 2 AS severity
FROM promises pr
WHERE pr.status = 'broken' AND pr.evaluated_at > now() - interval '30 days'
  AND NOT EXISTS (SELECT 1 FROM promises later WHERE later.customer_id = pr.customer_id
                    AND later.created_at > pr.evaluated_at AND later.status IN ('pending', 'fulfilled'))
UNION ALL
SELECT 'no_activity', o.customer_id, o.customer_id, NULL::uuid, la.last_activity, o.overdue::numeric(18,2), o.currency, 1
FROM (
  SELECT customer_id, sum(open_reporting) AS overdue, max(reporting_currency) AS currency
  FROM overdue GROUP BY customer_id
) o
CROSS JOIN tenant_settings ts
LEFT JOIN (
  SELECT a.customer_id, max(a.occurred_at) AS last_activity FROM activities a GROUP BY a.customer_id
) la ON la.customer_id = o.customer_id
WHERE coalesce(la.last_activity, '-infinity') < now() - make_interval(days => ts.attention_no_activity_days)
UNION ALL
SELECT 'large_overdue', y.customer_id, y.invoice_id, NULL::uuid, NULL::timestamptz, y.open_reporting::numeric(18,2),
       y.reporting_currency, 2
FROM (
  SELECT o.*, ts.attention_large_overdue AS threshold,
         row_number() OVER (ORDER BY o.open_reporting DESC NULLS LAST) AS rank
  FROM overdue o CROSS JOIN tenant_settings ts
) y
WHERE (y.threshold IS NOT NULL AND y.open_reporting >= y.threshold) OR (y.threshold IS NULL AND y.rank <= 5)
UNION ALL
SELECT 'unassigned_case', k.customer_id, k.id, k.id, k.opened_at, NULL::numeric(18,2), NULL::char(3), 1
FROM collection_cases k
WHERE k.status = 'open' AND k.owner_user_id IS NULL;
