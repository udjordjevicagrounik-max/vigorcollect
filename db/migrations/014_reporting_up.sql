-- 014_reporting_up.sql — Sprint 2, task 2.3: reporting helpers for the customer list, Customer
-- 360 and the dashboard. Definitions of every figure: docs/metrics.md. Protected file (rule 13).
--
-- Overdue (domain default): an invoice is overdue once the END of its due date has passed in the
-- time zone of the invoicing company (rule 26) — i.e. due_date < the company's local today.
-- Money stays numeric end to end (rule 18); conversion to the reporting currency uses the latest
-- reference rate on or before the day, preferring the tenant's jurisdiction source.

CREATE FUNCTION fx_convert(p_amount numeric, p_from char(3), p_to char(3), p_on date)
  RETURNS numeric
  LANGUAGE plpgsql
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  preferred text;
  r numeric;
BEGIN
  IF p_amount IS NULL OR p_from = p_to THEN
    RETURN p_amount;
  END IF;
  SELECT jp.fx_source INTO preferred
  FROM tenant_settings ts JOIN jurisdiction_profiles jp ON jp.country_code = ts.country_code
  WHERE ts.tenant_id = app_tenant_id();

  SELECT x.rate INTO r FROM exchange_rates x
  WHERE x.base_currency = p_from AND x.quote_currency = p_to AND x.valid_on <= p_on
  ORDER BY (x.source = preferred) DESC, x.valid_on DESC LIMIT 1;
  IF r IS NOT NULL THEN
    RETURN round(p_amount * r, 2);
  END IF;
  SELECT x.rate INTO r FROM exchange_rates x
  WHERE x.base_currency = p_to AND x.quote_currency = p_from AND x.valid_on <= p_on
  ORDER BY (x.source = preferred) DESC, x.valid_on DESC LIMIT 1;
  IF r IS NOT NULL THEN
    RETURN round(p_amount / r, 2);
  END IF;
  RETURN NULL; -- no rate: the caller counts it as "missing FX", never guesses
END $$;

REVOKE ALL ON FUNCTION fx_convert(numeric, char, char, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fx_convert(numeric, char, char, date) TO vigor_app;

-- One row per invoice with its position on the company's local today. security_invoker: the
-- caller's RLS applies to every underlying table (tenant isolation unchanged).
CREATE VIEW invoice_positions WITH (security_invoker = true) AS
SELECT
  i.id AS invoice_id,
  i.tenant_id,
  i.customer_id,
  i.company_id,
  i.number,
  i.issue_date,
  i.due_date,
  i.currency,
  i.amount_total,
  i.amount_open,
  i.accounting_status,
  d.local_today,
  (i.amount_open > 0 AND i.accounting_status NOT IN ('credited', 'cancelled')) AS is_open,
  (i.amount_open > 0 AND i.accounting_status NOT IN ('credited', 'cancelled')
   AND i.due_date < d.local_today) AS is_overdue,
  GREATEST(d.local_today - i.due_date, 0) AS days_overdue,
  b.code AS aging_bucket,
  ts.default_currency AS reporting_currency,
  fx_convert(i.amount_open, i.currency, ts.default_currency, d.local_today) AS open_reporting,
  fx_convert(i.amount_total, i.currency, ts.default_currency, i.issue_date) AS total_reporting
FROM invoices i
JOIN tenant_companies tc ON tc.tenant_id = i.tenant_id AND tc.id = i.company_id
JOIN legal_entities le ON le.id = tc.legal_entity_id
JOIN tenant_settings ts ON ts.tenant_id = i.tenant_id
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE le.timezone)::date AS local_today) d
LEFT JOIN aging_bucket_bounds b
  ON b.tenant_id = i.tenant_id
 AND GREATEST(d.local_today - i.due_date, 0) >= b.min_days_overdue
 AND (b.max_days_overdue IS NULL OR GREATEST(d.local_today - i.due_date, 0) <= b.max_days_overdue);

REVOKE ALL ON invoice_positions FROM PUBLIC;
GRANT SELECT ON invoice_positions TO vigor_app;
