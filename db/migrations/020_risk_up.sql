-- 020_risk_up.sql — Sprint 4.3: risk signals and explained scores (RiskProvider, rule 35).
-- Additive only. Protected (rule 13).
--
-- risk_signals: facts about a customer from internal data or an external provider, each with its
-- data source (rights per rule 35), observation time and validity (cache). risk_scores: a
-- deterministic score with its explanation (contribution per signal), model version and band —
-- never an unexplained number. Weights and band thresholds are tenant configuration. Which
-- external providers exist is per country (jurisdiction_profiles.risk_providers, rule 25).
-- A band is only a PROPOSAL for customers.credit_status (decisions; rules 11 and 19).

ALTER TABLE tenant_settings
  -- Points 0..100 per signal are weighted by these (integers); validated by the service (Zod).
  ADD COLUMN risk_weights jsonb NOT NULL DEFAULT
    '{"days_overdue": 35, "exposure_vs_limit": 20, "broken_promises_90d": 20, "disputes_90d": 15,
      "inactivity_days": 10, "external_blocked": 30}'::jsonb
    CHECK (jsonb_typeof(risk_weights) = 'object'),
  ADD COLUMN risk_band_yellow integer NOT NULL DEFAULT 35 CHECK (risk_band_yellow BETWEEN 1 AND 99),
  ADD COLUMN risk_band_red integer NOT NULL DEFAULT 65 CHECK (risk_band_red BETWEEN 2 AND 100),
  ADD CONSTRAINT tenant_settings_risk_bands CHECK (risk_band_yellow < risk_band_red);

-- Credit limit (exposure vs. limit signal). Set by import or a later maker-checker flow
-- (approval.credit_limit); NULL = no limit known → that signal does not count.
ALTER TABLE customers
  ADD COLUMN credit_limit numeric(18,2) CHECK (credit_limit > 0),
  ADD COLUMN credit_limit_currency char(3) CHECK (credit_limit_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT customers_credit_limit_pair CHECK ((credit_limit IS NULL) = (credit_limit_currency IS NULL));

-- External risk providers available per country (adapters live in src/server/risk/providers).
ALTER TABLE jurisdiction_profiles
  ADD COLUMN risk_providers text[] NOT NULL DEFAULT '{}'
    CHECK (risk_providers <@ ARRAY['checkpoint', 'apr', 'nbs']::text[]);
UPDATE jurisdiction_profiles SET risk_providers = ARRAY['checkpoint', 'apr', 'nbs'] WHERE country_code = 'RS';

CREATE TABLE risk_signals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  customer_id     uuid        NOT NULL,
  signal_type     text        NOT NULL CHECK (signal_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- 'internal' or the provider key; the rights of the data are in data_sources.
  source          text        NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,30}$'),
  data_source_id  uuid,
  -- Numeric value (days, percent, count, 0/1); NULL = not available (explained, not scored).
  value           numeric(18,4),
  observed_at     timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz,
  -- Reference to the raw source (sync_runs id, external record id) — never the raw payload.
  raw_ref         text        CHECK (length(raw_ref) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_signals_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT risk_signals_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT risk_signals_data_source FOREIGN KEY (tenant_id, data_source_id) REFERENCES data_sources (tenant_id, id),
  CONSTRAINT risk_signals_external_source CHECK ((source = 'internal') = (data_source_id IS NULL))
);
CREATE INDEX risk_signals_latest ON risk_signals (tenant_id, customer_id, signal_type, observed_at DESC);

CREATE TABLE risk_scores (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  customer_id    uuid        NOT NULL,
  score          integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  band           text        NOT NULL CHECK (band IN ('green', 'yellow', 'red')),
  previous_band  text        CHECK (previous_band IN ('green', 'yellow', 'red')),
  -- {model, weights, thresholds, contributions: [{signal, value, points, weight, source}], ...}
  explanation    jsonb       NOT NULL CHECK (jsonb_typeof(explanation) = 'object' AND explanation ? 'contributions'),
  model_version  text        NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9._-]{1,40}$'),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_scores_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT risk_scores_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX risk_scores_latest ON risk_scores (tenant_id, customer_id, computed_at DESC);

ALTER TABLE risk_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_signals
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE risk_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON risk_scores
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Signals and scores are history (a new observation is a new row).
REVOKE UPDATE, DELETE, TRUNCATE ON risk_signals, risk_scores FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 020)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('risk_signals', 'risk_scores')
       OR (c.table_name, c.column_name) IN (('tenant_settings', 'risk_weights'), ('tenant_settings', 'risk_band_yellow'),
                                            ('tenant_settings', 'risk_band_red'), ('customers', 'credit_limit'),
                                            ('customers', 'credit_limit_currency'),
                                            ('jurisdiction_profiles', 'risk_providers')))
ON CONFLICT (table_name, column_name) DO NOTHING;
