-- 028_report_builder_up.sql — Sprint 6.2: report builder definitions.
-- Protected (rule 13). Additive; provision_receivables_defaults() is re-created with one more call.
--
-- report_definitions: a report = dataset + dimensions + measures + filters + sort + limit + visual
--   (src/server/reporting/*: white-listed fields only, never SQL). Config only — ids, field keys,
--   codes, dates (P0). Private, team or tenant-wide. is_system = the six base reports of 5.2 in
--   this model, one set per tenant (system_key), never deleted, copied to make an own version.

CREATE TABLE report_definitions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  owner_user_id  uuid,
  name           text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  system_key     text        CHECK (system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  dataset        text        NOT NULL CHECK (dataset IN ('invoices', 'customers', 'cases', 'promises',
                                                         'activities', 'disputes', 'payments', 'risk')),
  dimensions     jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dimensions) = 'array'),
  measures       jsonb       NOT NULL CHECK (jsonb_typeof(measures) = 'array'),
  filters        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(filters) = 'array'),
  sort           jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sort) = 'array'),
  row_limit      integer     NOT NULL DEFAULT 1000 CHECK (row_limit BETWEEN 1 AND 10000),
  visual         text        NOT NULL DEFAULT 'table'
                             CHECK (visual IN ('table', 'bar', 'stacked_bar', 'line', 'pie', 'donut', 'funnel',
                                               'kpi_number', 'kpi_trend', 'grouped_table')),
  visual_config  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(visual_config) = 'object'),
  visibility     text        NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'tenant')),
  team_id        uuid,
  version        integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_system      boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  CONSTRAINT report_definitions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT report_definitions_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT report_definitions_team FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id),
  CONSTRAINT report_definitions_system CHECK (
    (is_system AND owner_user_id IS NULL AND visibility = 'tenant' AND system_key IS NOT NULL)
    OR (NOT is_system AND owner_user_id IS NOT NULL AND system_key IS NULL)),
  CONSTRAINT report_definitions_team_vis CHECK ((visibility = 'team') = (team_id IS NOT NULL))
);
CREATE UNIQUE INDEX report_definitions_system_key ON report_definitions (tenant_id, system_key) WHERE is_system;
CREATE INDEX report_definitions_owner_idx ON report_definitions (tenant_id, owner_user_id);
CREATE TRIGGER report_definitions_updated_at BEFORE UPDATE ON report_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A system report is never deleted or edited in place (copy it).
CREATE FUNCTION report_definitions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.is_system AND current_setting('app.system_reports', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'system report definitions are read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER report_definitions_system_ro BEFORE UPDATE OR DELETE ON report_definitions
  FOR EACH ROW EXECUTE FUNCTION report_definitions_guard();

CREATE FUNCTION provision_sprint6_reports() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_sprint6_reports requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO report_definitions (tenant_id, name, system_key, dataset, dimensions, measures, filters, visual,
                                  visibility, is_system)
  SELECT t, v.name, v.k, v.ds, v.dims::jsonb, v.meas::jsonb, v.flt::jsonb, v.vis, 'tenant', true
  FROM (VALUES
    ('aging_by_customer', 'Aging po kupcu', 'invoices',
     '[{"field":"customer"},{"field":"aging_bucket"}]',
     '[{"field":"open_amount","agg":"sum","fx":true}]',
     '[{"field":"is_open","op":"eq","value":true}]', 'grouped_table'),
    ('aging_by_collector', 'Aging po naplataru', 'invoices',
     '[{"field":"owner"},{"field":"aging_bucket"}]',
     '[{"field":"open_amount","agg":"sum","fx":true}]',
     '[{"field":"is_open","op":"eq","value":true}]', 'grouped_table'),
    ('collected_by_period', 'Naplaćeno po periodu', 'payments',
     '[{"field":"paid_on","grain":"month"}]',
     '[{"field":"amount","agg":"sum","fx":true}]',
     '[{"field":"payment_kind","op":"eq","value":"payment"},{"field":"paid_on","op":"relative","value":"last_90_days"}]', 'bar'),
    ('promises', 'Obećanja', 'promises',
     '[{"field":"promise_status"}]',
     '[{"field":"count","agg":"count","fx":true},{"field":"promised_amount","agg":"sum","fx":true},{"field":"paid_amount","agg":"sum","fx":true}]',
     '[{"field":"promised_on","op":"relative","value":"last_90_days"},{"field":"promise_status","op":"ne","value":"cancelled"}]', 'bar'),
    ('cases_by_stage', 'Case-ovi po fazi', 'cases',
     '[{"field":"stage"}]',
     '[{"field":"count","agg":"count","fx":true}]',
     '[{"field":"case_status","op":"eq","value":"open"}]', 'funnel'),
    ('disputes', 'Sporovi', 'disputes',
     '[{"field":"reason"},{"field":"dispute_status"}]',
     '[{"field":"count","agg":"count","fx":true}]',
     '[{"field":"opened_on","op":"relative","value":"last_90_days"}]', 'stacked_bar')
  ) AS v(k, name, ds, dims, meas, flt, vis)
  ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION provision_receivables_defaults() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_receivables_defaults requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO code_lists (tenant_id, list_key, code, is_system, sort_order)
  SELECT t, v.list_key, v.code, true, v.sort_order
  FROM (VALUES
    ('aging_bucket', 'current', 0), ('aging_bucket', 'd1_30', 1), ('aging_bucket', 'd31_60', 2),
    ('aging_bucket', 'd61_90', 3), ('aging_bucket', 'd91_180', 4), ('aging_bucket', 'd181_plus', 5),
    ('case_stage', 'new', 0), ('case_stage', 'contact', 1), ('case_stage', 'promise', 2),
    ('case_stage', 'dispute', 3), ('case_stage', 'legal', 4), ('case_stage', 'resolved', 5),
    ('activity_outcome', 'reached', 0), ('activity_outcome', 'no_answer', 1),
    ('activity_outcome', 'promise_given', 2), ('activity_outcome', 'dispute_raised', 3),
    ('activity_outcome', 'wrong_contact', 4), ('activity_outcome', 'callback', 5),
    ('next_action', 'call', 0), ('next_action', 'email', 1), ('next_action', 'meeting', 2),
    ('next_action', 'check_payment', 3),
    -- 015: why a source lowered an open amount without a payment
    ('adjustment_reason', 'unknown', 0), ('adjustment_reason', 'credit_note', 1),
    ('adjustment_reason', 'write_off', 2), ('adjustment_reason', 'source_correction', 3)
  ) AS v(list_key, code, sort_order)
  ON CONFLICT (tenant_id, list_key, code) DO NOTHING;

  -- The tenant's own ERP export, uploaded as a file (import wizard, 2.2). Own data: may be
  -- displayed, stored and derived from; never redistributed.
  INSERT INTO data_sources (tenant_id, name, source_type, may_display, may_store, may_derive)
  VALUES (t, 'file-import', 'ERP_FILE', true, true, true)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO aging_bucket_bounds (tenant_id, code, min_days_overdue, max_days_overdue)
  VALUES (t, 'current', 0, 0), (t, 'd1_30', 1, 30), (t, 'd31_60', 31, 60), (t, 'd61_90', 61, 90),
         (t, 'd91_180', 91, 180), (t, 'd181_plus', 181, NULL)
  ON CONFLICT (tenant_id, code) DO NOTHING;

  INSERT INTO translations (tenant_id, entity_type, entity_key, locale, text)
  SELECT t, 'code_list', v.k, v.loc, v.txt
  FROM (VALUES
    ('aging_bucket.current', 'sr-Latn', 'Nije dospelo'), ('aging_bucket.current', 'en', 'Not due'),
    ('aging_bucket.d1_30', 'sr-Latn', '1–30 dana'), ('aging_bucket.d1_30', 'en', '1–30 days'),
    ('aging_bucket.d31_60', 'sr-Latn', '31–60 dana'), ('aging_bucket.d31_60', 'en', '31–60 days'),
    ('aging_bucket.d61_90', 'sr-Latn', '61–90 dana'), ('aging_bucket.d61_90', 'en', '61–90 days'),
    ('aging_bucket.d91_180', 'sr-Latn', '91–180 dana'), ('aging_bucket.d91_180', 'en', '91–180 days'),
    ('aging_bucket.d181_plus', 'sr-Latn', 'Preko 180 dana'), ('aging_bucket.d181_plus', 'en', 'Over 180 days'),
    ('case_stage.new', 'sr-Latn', 'Novi'), ('case_stage.new', 'en', 'New'),
    ('case_stage.contact', 'sr-Latn', 'Kontakt'), ('case_stage.contact', 'en', 'Contact'),
    ('case_stage.promise', 'sr-Latn', 'Obećanje'), ('case_stage.promise', 'en', 'Promise'),
    ('case_stage.dispute', 'sr-Latn', 'Spor'), ('case_stage.dispute', 'en', 'Dispute'),
    ('case_stage.legal', 'sr-Latn', 'Pravna služba'), ('case_stage.legal', 'en', 'Legal'),
    ('case_stage.resolved', 'sr-Latn', 'Rešeno'), ('case_stage.resolved', 'en', 'Resolved'),
    ('activity_outcome.reached', 'sr-Latn', 'Dobijen kontakt'), ('activity_outcome.reached', 'en', 'Reached'),
    ('activity_outcome.no_answer', 'sr-Latn', 'Bez odgovora'), ('activity_outcome.no_answer', 'en', 'No answer'),
    ('activity_outcome.promise_given', 'sr-Latn', 'Dato obećanje'), ('activity_outcome.promise_given', 'en', 'Promise given'),
    ('activity_outcome.dispute_raised', 'sr-Latn', 'Prijavljen spor'), ('activity_outcome.dispute_raised', 'en', 'Dispute raised'),
    ('activity_outcome.wrong_contact', 'sr-Latn', 'Pogrešan kontakt'), ('activity_outcome.wrong_contact', 'en', 'Wrong contact'),
    ('activity_outcome.callback', 'sr-Latn', 'Zvati ponovo'), ('activity_outcome.callback', 'en', 'Call back'),
    ('next_action.call', 'sr-Latn', 'Poziv'), ('next_action.call', 'en', 'Call'),
    ('next_action.email', 'sr-Latn', 'Email'), ('next_action.email', 'en', 'Email'),
    ('next_action.meeting', 'sr-Latn', 'Sastanak'), ('next_action.meeting', 'en', 'Meeting'),
    ('next_action.check_payment', 'sr-Latn', 'Proveri uplatu'), ('next_action.check_payment', 'en', 'Check payment'),
    ('adjustment_reason.unknown', 'sr-Latn', 'Nepoznat razlog'), ('adjustment_reason.unknown', 'en', 'Unknown reason'),
    ('adjustment_reason.credit_note', 'sr-Latn', 'Knjižno odobrenje'), ('adjustment_reason.credit_note', 'en', 'Credit note'),
    ('adjustment_reason.write_off', 'sr-Latn', 'Otpis'), ('adjustment_reason.write_off', 'en', 'Write-off'),
    ('adjustment_reason.source_correction', 'sr-Latn', 'Ispravka u izvoru'), ('adjustment_reason.source_correction', 'en', 'Source correction')
  ) AS v(k, loc, txt)
  ON CONFLICT (tenant_id, entity_type, entity_key, field, locale) DO NOTHING;

  -- 016: collection policies and the Standard workflows.
  PERFORM provision_collection_defaults();
  -- 024 (Sprint 5.1): dispute reasons and payment behaviour.
  PERFORM provision_sprint5_defaults();
  PERFORM provision_sprint6_reports();
END $$;

-- Existing tenants: the owner reads tenants only through the tenant_clock GUC (007), one tenant
-- context per provisioning call (same pattern as 024).
DO $$
DECLARE
  tid uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR tid IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    IF EXISTS (SELECT 1 FROM code_lists WHERE list_key = 'aging_bucket') THEN
      PERFORM provision_sprint6_reports();
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

ALTER TABLE report_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_definitions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
REVOKE TRUNCATE ON report_definitions FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 028)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'report_definitions';
