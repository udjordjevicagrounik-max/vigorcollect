-- 020_risk_down.sql — reverts 020_risk_up.sql (dev/test only, rule 15). Deletes all risk
-- signals and scores, credit limits and risk settings.

DELETE FROM pii_field_registry
WHERE table_name IN ('risk_signals', 'risk_scores')
   OR (table_name, column_name) IN (('tenant_settings', 'risk_weights'), ('tenant_settings', 'risk_band_yellow'),
                                    ('tenant_settings', 'risk_band_red'), ('customers', 'credit_limit'),
                                    ('customers', 'credit_limit_currency'), ('jurisdiction_profiles', 'risk_providers'));

DROP TABLE IF EXISTS risk_scores;
DROP TABLE IF EXISTS risk_signals;

ALTER TABLE jurisdiction_profiles DROP COLUMN IF EXISTS risk_providers;
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_credit_limit_pair,
  DROP COLUMN IF EXISTS credit_limit_currency,
  DROP COLUMN IF EXISTS credit_limit;
ALTER TABLE tenant_settings
  DROP CONSTRAINT IF EXISTS tenant_settings_risk_bands,
  DROP COLUMN IF EXISTS risk_band_red,
  DROP COLUMN IF EXISTS risk_band_yellow,
  DROP COLUMN IF EXISTS risk_weights;
