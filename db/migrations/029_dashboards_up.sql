-- 029_dashboards_up.sql — Sprint 6.3: dashboards.
-- Protected (rule 13). Additive; provision_receivables_defaults() re-created with one more call.
--
-- dashboards: named grid (12 columns) of widgets — private, team or tenant-wide; a manager may
--   make one the default of roles. is_system = "Collections overview" (the 2.3 dashboard in this
--   model), one per tenant, read-only, copied into a personal one.
-- dashboard_widgets: a saved report (with an optional visual override), a system KPI with its
--   definition, aging, attention list, my tasks, my team's work. Position + size (3/4/6/8/12).
-- user_dashboard_prefs: the member's home dashboard.
-- Widget data is cached in the app process for 5 minutes per (dashboard, member) — never stored.

CREATE TABLE dashboards (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants (id),
  owner_user_id      uuid,
  name               text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  system_key         text        CHECK (system_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  visibility         text        NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'team', 'tenant')),
  team_id            uuid,
  default_for_roles  text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(default_for_roles) <= 20),
  is_system          boolean     NOT NULL DEFAULT false,
  version            integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  CONSTRAINT dashboards_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT dashboards_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT dashboards_team FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id),
  CONSTRAINT dashboards_system CHECK (
    (is_system AND owner_user_id IS NULL AND visibility = 'tenant' AND system_key IS NOT NULL)
    OR (NOT is_system AND owner_user_id IS NOT NULL AND system_key IS NULL)),
  CONSTRAINT dashboards_team_vis CHECK ((visibility = 'team') = (team_id IS NOT NULL))
);
CREATE UNIQUE INDEX dashboards_system_key ON dashboards (tenant_id, system_key) WHERE is_system;
CREATE TRIGGER dashboards_updated_at BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dashboard_widgets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  dashboard_id  uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('report', 'kpi', 'aging', 'attention', 'my_tasks', 'team_attention')),
  report_id     uuid,
  kpi_key       text        CHECK (kpi_key IN ('overdue_total', 'open_total', 'dso', 'promises_today', 'promises_broken', 'open_cases', 'collected_30', 'collection_rate', 'disputed')),
  visual        text        CHECK (visual IN ('table', 'bar', 'stacked_bar', 'line', 'pie', 'donut', 'funnel',
                                              'kpi_number', 'kpi_trend', 'grouped_table')),
  size          smallint    NOT NULL DEFAULT 6 CHECK (size IN (3, 4, 6, 8, 12)),
  position      integer     NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  title         text        CHECK (btrim(title) <> '' AND length(title) <= 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  CONSTRAINT dashboard_widgets_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT dashboard_widgets_dashboard FOREIGN KEY (tenant_id, dashboard_id)
    REFERENCES dashboards (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT dashboard_widgets_report FOREIGN KEY (tenant_id, report_id)
    REFERENCES report_definitions (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT dashboard_widgets_kind CHECK (
    (kind = 'report') = (report_id IS NOT NULL) AND (kind = 'kpi') = (kpi_key IS NOT NULL))
);
CREATE INDEX dashboard_widgets_dashboard_idx ON dashboard_widgets (tenant_id, dashboard_id, position);

CREATE TABLE user_dashboard_prefs (
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  user_id       uuid        NOT NULL,
  dashboard_id  uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT user_dashboard_prefs_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT user_dashboard_prefs_dashboard FOREIGN KEY (tenant_id, dashboard_id)
    REFERENCES dashboards (tenant_id, id) ON DELETE CASCADE
);

-- The system dashboard and its widgets are read-only (copy it to change it).
CREATE FUNCTION dashboards_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  sys boolean;
BEGIN
  IF current_setting('app.system_reports', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'dashboards' THEN
    sys := OLD.is_system;
  ELSE
    SELECT d.is_system INTO sys FROM dashboards d
    WHERE d.id = CASE WHEN TG_OP = 'INSERT' THEN NEW.dashboard_id ELSE OLD.dashboard_id END;
  END IF;
  IF coalesce(sys, false) THEN
    RAISE EXCEPTION 'the system dashboard is read-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER dashboards_system_ro BEFORE UPDATE OR DELETE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION dashboards_guard();
CREATE TRIGGER dashboard_widgets_system_ro BEFORE INSERT OR UPDATE OR DELETE ON dashboard_widgets
  FOR EACH ROW EXECUTE FUNCTION dashboards_guard();

CREATE FUNCTION provision_sprint6_dashboards() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
  d uuid;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_sprint6_dashboards requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- tenant_id explicit: the backfill below runs before RLS is enabled on dashboards.
  IF EXISTS (SELECT 1 FROM dashboards
             WHERE tenant_id = t AND is_system AND system_key = 'collections_overview') THEN
    RETURN;
  END IF;
  PERFORM set_config('app.system_reports', 'on', true);
  INSERT INTO dashboards (tenant_id, name, system_key, visibility, is_system)
  VALUES (t, 'Pregled naplate', 'collections_overview', 'tenant', true) RETURNING id INTO d;
  INSERT INTO dashboard_widgets (tenant_id, dashboard_id, kind, kpi_key, size, position)
  SELECT t, d, 'kpi', k.key, 4, k.pos
  FROM (VALUES ('overdue_total', 0), ('open_total', 1), ('dso', 2), ('promises_today', 3),
               ('promises_broken', 4), ('disputed', 5), ('open_cases', 6), ('collected_30', 7),
               ('collection_rate', 8)) AS k(key, pos);
  INSERT INTO dashboard_widgets (tenant_id, dashboard_id, kind, size, position)
  VALUES (t, d, 'attention', 12, 20), (t, d, 'aging', 6, 30), (t, d, 'my_tasks', 6, 31);
  PERFORM set_config('app.system_reports', '', true);
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
  PERFORM provision_sprint6_dashboards();
END $$;

-- Existing tenants (same pattern as 024 / 028).
DO $$
DECLARE
  tid uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR tid IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    IF EXISTS (SELECT 1 FROM code_lists WHERE list_key = 'aging_bucket') THEN
      PERFORM provision_sprint6_dashboards();
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;

ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboards
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboard_widgets
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE user_dashboard_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_dashboard_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_dashboard_prefs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
REVOKE TRUNCATE ON dashboards, dashboard_widgets, user_dashboard_prefs FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 029)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name IN ('dashboards', 'dashboard_widgets', 'user_dashboard_prefs');
