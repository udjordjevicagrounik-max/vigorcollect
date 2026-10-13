-- 016_workflows_up.sql — Sprint 3: rule engine (3.1), communication and documents (3.2),
-- attention (3.2). Additive only (rule 15). Protected file (rule 13).
--
-- Rule engine: a workflow is configuration (trigger + conditions + actions as jsonb — it is not
-- money, a due date or a case status, rule 15). A published version is immutable; a change is a
-- new version; publishing is maker-checker (approval_request 'workflow.publish'). Every run is
-- recorded with its version, trigger, entity, explanation and per-action results; the same
-- trigger + version + entity is one run (idempotency).

-- ============================================================================================
-- Collection policy per customer (code list 'collection_policy'); tenant default
-- ============================================================================================

ALTER TABLE tenant_settings
  ADD COLUMN default_policy_code text NOT NULL DEFAULT 'standard'
    CHECK (default_policy_code ~ '^[a-z][a-z0-9_]{0,40}$');

ALTER TABLE customers
  ADD COLUMN policy_list_key text NOT NULL GENERATED ALWAYS AS ('collection_policy') STORED,
  ADD COLUMN policy_code text,
  ADD CONSTRAINT customers_policy FOREIGN KEY (tenant_id, policy_list_key, policy_code)
    REFERENCES code_lists (tenant_id, list_key, code);

-- ============================================================================================
-- Workflows
-- ============================================================================================

CREATE TABLE workflows (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  key         text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name        text        NOT NULL CHECK (name <> '' AND length(name) <= 120),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT workflows_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT workflows_key_unique UNIQUE (tenant_id, key)
);

CREATE TABLE workflow_versions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id),
  workflow_id          uuid        NOT NULL,
  version              integer     NOT NULL CHECK (version >= 1),
  status               text        NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft', 'pending_approval', 'published', 'superseded', 'rejected')),
  definition           jsonb       NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  provisioned          boolean     NOT NULL DEFAULT false,
  approval_request_id  uuid,
  published_at         timestamptz,
  published_by         uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  CONSTRAINT workflow_versions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT workflow_versions_number UNIQUE (tenant_id, workflow_id, version),
  CONSTRAINT workflow_versions_workflow FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  CONSTRAINT workflow_versions_approval FOREIGN KEY (tenant_id, approval_request_id)
    REFERENCES approval_requests (tenant_id, id),
  CONSTRAINT workflow_versions_published_by FOREIGN KEY (tenant_id, published_by) REFERENCES users (tenant_id, id),
  -- Publishing is maker-checker; only tenant provisioning (seed) publishes without a request.
  CONSTRAINT workflow_versions_publish_approved
    CHECK (status NOT IN ('published', 'superseded') OR approval_request_id IS NOT NULL OR provisioned),
  CONSTRAINT workflow_versions_published_at
    CHECK ((status IN ('published', 'superseded')) = (published_at IS NOT NULL))
);
CREATE UNIQUE INDEX workflow_versions_one_published ON workflow_versions (tenant_id, workflow_id)
  WHERE status = 'published';
CREATE UNIQUE INDEX workflow_versions_one_open ON workflow_versions (tenant_id, workflow_id)
  WHERE status IN ('draft', 'pending_approval');

-- A version that left 'draft' never changes its definition; statuses only move forward.
CREATE FUNCTION workflow_versions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.definition IS DISTINCT FROM OLD.definition THEN
    RAISE EXCEPTION 'workflow_versions: a submitted or published version is immutable — create a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version OR NEW.workflow_id <> OLD.workflow_id OR NEW.provisioned <> OLD.provisioned THEN
    RAISE EXCEPTION 'workflow_versions: identity is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
       NEW.status = OLD.status
    OR (OLD.status = 'draft' AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('published', 'rejected', 'draft'))
    OR (OLD.status = 'published' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'workflow_versions: status % → % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_versions_guard BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION workflow_versions_guard();

CREATE TABLE workflow_runs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id),
  workflow_version_id  uuid        NOT NULL,
  trigger_type         text        NOT NULL CHECK (trigger_type ~ '^[a-z][a-z0-9_.]{1,62}$'),
  trigger_key          text        NOT NULL CHECK (trigger_key <> '' AND length(trigger_key) <= 200),
  event_id             uuid,
  entity_type          text        NOT NULL CHECK (entity_type IN ('invoice', 'customer', 'case', 'payment', 'promise')),
  entity_id            uuid        NOT NULL,
  customer_id          uuid,
  case_id              uuid,
  status               text        NOT NULL CHECK (status IN ('running', 'skipped', 'succeeded', 'failed')),
  explanation          jsonb       NOT NULL CHECK (jsonb_typeof(explanation) = 'object'),
  error_code           text        CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  duration_ms          integer     CHECK (duration_ms >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT workflow_runs_version FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES workflow_versions (tenant_id, id),
  CONSTRAINT workflow_runs_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT workflow_runs_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  -- Idempotency: the same trigger occurrence on the same entity runs a version once.
  CONSTRAINT workflow_runs_once UNIQUE (tenant_id, workflow_version_id, trigger_key, entity_id),
  CONSTRAINT workflow_runs_failed CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
-- A run is written once more when it finishes, never after (history).
CREATE FUNCTION workflow_runs_finish_once() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'running' OR NEW.workflow_version_id <> OLD.workflow_version_id
     OR NEW.trigger_key <> OLD.trigger_key OR NEW.entity_id <> OLD.entity_id THEN
    RAISE EXCEPTION 'workflow_runs: a finished run is history' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_runs_finish_once BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_runs_finish_once();

CREATE INDEX workflow_runs_case ON workflow_runs (tenant_id, case_id, started_at) WHERE case_id IS NOT NULL;
CREATE INDEX workflow_runs_recent ON workflow_runs (tenant_id, started_at DESC);
CREATE INDEX workflow_runs_failed_idx ON workflow_runs (tenant_id, started_at DESC) WHERE status = 'failed';

CREATE TABLE workflow_run_actions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  run_id       uuid        NOT NULL,
  position     integer     NOT NULL CHECK (position >= 0),
  action_type  text        NOT NULL CHECK (action_type ~ '^[a-z][a-z_]{1,40}$'),
  status       text        NOT NULL CHECK (status IN ('succeeded', 'skipped', 'failed')),
  -- ids and codes only (never personal data): {"case_id": …, "reason": "rule_19"}
  result       jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(result) = 'object'),
  request_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  error_code   text        CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_run_actions_run FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, id),
  CONSTRAINT workflow_run_actions_position UNIQUE (tenant_id, run_id, position)
);

ALTER TABLE collection_cases
  ADD COLUMN workflow_version_id uuid,
  ADD CONSTRAINT collection_cases_workflow_version
    FOREIGN KEY (tenant_id, workflow_version_id) REFERENCES workflow_versions (tenant_id, id);

-- ============================================================================================
-- Tasks and in-app notifications (actions create_task, send_notification, escalate)
-- ============================================================================================

CREATE TABLE tasks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants (id),
  customer_id       uuid        NOT NULL,
  case_id           uuid,
  assignee_user_id  uuid,
  kind_list_key     text        NOT NULL GENERATED ALWAYS AS ('next_action') STORED,
  kind_code         text        NOT NULL,
  due_on            date        NOT NULL,
  status            text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at      timestamptz,
  source_run_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid,
  CONSTRAINT tasks_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT tasks_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT tasks_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT tasks_assignee FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT tasks_kind FOREIGN KEY (tenant_id, kind_list_key, kind_code) REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT tasks_run FOREIGN KEY (tenant_id, source_run_id) REFERENCES workflow_runs (tenant_id, id),
  CONSTRAINT tasks_completed CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX tasks_assignee_open ON tasks (tenant_id, assignee_user_id, due_on) WHERE status = 'open';

CREATE TABLE notifications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  user_id        uuid        NOT NULL,
  -- message key from the whitelist in messages/*.json (notifications.*) — never free text
  message_key    text        NOT NULL CHECK (message_key ~ '^[a-z][a-z_]{1,60}$'),
  customer_id    uuid,
  case_id        uuid,
  source_run_id  uuid,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT notifications_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT notifications_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT notifications_run FOREIGN KEY (tenant_id, source_run_id) REFERENCES workflow_runs (tenant_id, id)
);
CREATE INDEX notifications_unread ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;

-- Decisions proposed by a rule point to their run and case. Rule 19 stays enforced by the
-- existing guard (natural person + legal effect → only a human approves; 002/003).
ALTER TABLE decisions
  ADD COLUMN case_id uuid,
  ADD CONSTRAINT decisions_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  ADD COLUMN source_run_id uuid,
  ADD CONSTRAINT decisions_run FOREIGN KEY (tenant_id, source_run_id) REFERENCES workflow_runs (tenant_id, id);

CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER workflow_versions_updated_at BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Templates (3.2): metadata and versions in `templates`; subject / body per locale in
-- `template_texts` (tenant-edited text per locale — rule 17; `translations` is limited by its
-- CHECKs to role / code_list names). Variables only from the whitelist of
-- src/server/templates/render.ts; bodies only from the whitelisted HTML tags.
-- ============================================================================================

CREATE TABLE templates (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants (id),
  key               text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  channel           text        NOT NULL CHECK (channel IN ('email', 'document')),
  name              text        NOT NULL CHECK (name <> '' AND length(name) <= 120),
  version           integer     NOT NULL CHECK (version >= 1),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  -- e.g. a pre-litigation notice: never sent to a natural person by a rule (rule 19)
  has_legal_effect  boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid,
  CONSTRAINT templates_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT templates_version UNIQUE (tenant_id, key, channel, version)
);
CREATE UNIQUE INDEX templates_one_active ON templates (tenant_id, key, channel) WHERE status = 'active';

-- A template version never changes; a new text is a new version.
CREATE FUNCTION templates_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.key <> OLD.key OR NEW.channel <> OLD.channel OR NEW.version <> OLD.version
     OR NEW.has_legal_effect <> OLD.has_legal_effect
     OR NOT (NEW.status = OLD.status OR (OLD.status = 'active' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'templates: a version is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE template_texts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id),
  template_id  uuid        NOT NULL,
  locale       text        NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  subject      text        NOT NULL CHECK (subject <> '' AND length(subject) <= 300),
  body         text        NOT NULL CHECK (body <> '' AND length(body) <= 20000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT template_texts_template FOREIGN KEY (tenant_id, template_id) REFERENCES templates (tenant_id, id),
  CONSTRAINT template_texts_unique UNIQUE (tenant_id, template_id, locale)
);

CREATE TRIGGER templates_guard BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION templates_guard();
CREATE TRIGGER templates_updated_at BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Documents (3.2): metadata only — the content lives in the storage adapter, encrypted with a
-- per-tenant key; never a direct URL (download = exportService + export_log, rule 12).
-- ============================================================================================

CREATE TABLE documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id),
  customer_id    uuid        NOT NULL,
  case_id        uuid,
  kind           text        NOT NULL CHECK (kind IN ('dunning_letter', 'statement')),
  template_id    uuid        NOT NULL,
  format         text        NOT NULL CHECK (format IN ('html', 'pdf')),
  locale         text        NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  version        integer     NOT NULL CHECK (version >= 1),
  checksum       bytea       NOT NULL CHECK (length(checksum) = 32),
  size_bytes     integer     NOT NULL CHECK (size_bytes > 0),
  storage_ref    text        NOT NULL CHECK (storage_ref ~ '^[a-z]+:[A-Za-z0-9/_.-]{1,250}$'),
  key_version    integer     NOT NULL CHECK (key_version >= 1),
  source_run_id  uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  CONSTRAINT documents_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT documents_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT documents_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT documents_template FOREIGN KEY (tenant_id, template_id) REFERENCES templates (tenant_id, id),
  CONSTRAINT documents_run FOREIGN KEY (tenant_id, source_run_id) REFERENCES workflow_runs (tenant_id, id),
  CONSTRAINT documents_version UNIQUE (tenant_id, customer_id, kind, version)
);
CREATE INDEX documents_customer ON documents (tenant_id, customer_id, created_at DESC);

-- ============================================================================================
-- Attention (3.2): thresholds are configuration; customer-related items as one view
-- ============================================================================================

ALTER TABLE tenant_settings
  ADD COLUMN attention_no_activity_days integer NOT NULL DEFAULT 14
    CHECK (attention_no_activity_days BETWEEN 1 AND 365),
  -- NULL = "large" means the 5 largest overdue invoices (no amount hard-coded anywhere)
  ADD COLUMN attention_large_overdue numeric(18,2) CHECK (attention_large_overdue > 0);

-- One row per thing that needs a person, about a customer. security_invoker: tenant RLS of the
-- caller applies; the service adds scope (scopeFilter) and the member-specific items.
CREATE VIEW attention_customer_items WITH (security_invoker = true) AS
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

REVOKE ALL ON attention_customer_items FROM PUBLIC;
GRANT SELECT ON attention_customer_items TO vigor_app;

-- ============================================================================================
-- Tenant defaults: collection policies + the "Standard" policy as workflows (configuration, never
-- code). Offsets in days from the due date in the company's zone (rule 26; D-7 in business days).
-- ============================================================================================

CREATE FUNCTION provision_collection_defaults() RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  t uuid := app_tenant_id();
  w record;
  wid uuid;
  tpl record;
  tid uuid;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'provision_collection_defaults requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO code_lists (tenant_id, list_key, code, is_system, sort_order)
  VALUES (t, 'collection_policy', 'friendly', true, 0), (t, 'collection_policy', 'standard', true, 1),
         (t, 'collection_policy', 'strict', true, 2), (t, 'collection_policy', 'strategic', true, 3)
  ON CONFLICT (tenant_id, list_key, code) DO NOTHING;
  INSERT INTO translations (tenant_id, entity_type, entity_key, locale, text)
  VALUES (t, 'code_list', 'collection_policy.friendly', 'sr-Latn', 'Blaga'),
         (t, 'code_list', 'collection_policy.friendly', 'en', 'Friendly'),
         (t, 'code_list', 'collection_policy.standard', 'sr-Latn', 'Standardna'),
         (t, 'code_list', 'collection_policy.standard', 'en', 'Standard'),
         (t, 'code_list', 'collection_policy.strict', 'sr-Latn', 'Stroga'),
         (t, 'code_list', 'collection_policy.strict', 'en', 'Strict'),
         (t, 'code_list', 'collection_policy.strategic', 'sr-Latn', 'Strateški kupac'),
         (t, 'code_list', 'collection_policy.strategic', 'en', 'Strategic')
  ON CONFLICT (tenant_id, entity_type, entity_key, field, locale) DO NOTHING;

  FOR w IN SELECT * FROM (VALUES
    ('std_before_due', 'Standard: podsetnik 7 radnih dana pre dospeća',
     '{"trigger":{"type":"days_from_due","offset":-7,"businessDays":true},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"queue_email","template":"reminder_before_due"}]}'),
    ('std_overdue_d1', 'Standard: podsetnik dan posle dospeća',
     '{"trigger":{"type":"days_from_due","offset":1},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"queue_email","template":"reminder_overdue"}]}'),
    ('std_overdue_d7', 'Standard: drugi podsetnik i case (D+7)',
     '{"trigger":{"type":"days_from_due","offset":7},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"queue_email","template":"reminder_second"},{"type":"create_case","priority":"normal"}]}'),
    ('std_call_d14', 'Standard: poziv (D+14)',
     '{"trigger":{"type":"days_from_due","offset":14},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"create_case","priority":"normal"},{"type":"create_task","kind":"call","dueInDays":0}]}'),
    ('std_escalate_d30', 'Standard: eskalacija menadžeru (D+30)',
     '{"trigger":{"type":"days_from_due","offset":30},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"create_case","priority":"high"},{"type":"escalate"}]}'),
    ('std_pre_litigation_company', 'Standard: opomena pred utuženje — pravno lice (D+60)',
     '{"trigger":{"type":"days_from_due","offset":60},
       "conditions":[{"field":"policy","op":"eq","value":"standard"},{"field":"is_natural_person","op":"eq","value":false}],
       "actions":[{"type":"queue_email","template":"pre_litigation_notice"}]}'),
    ('std_pre_litigation_person', 'Standard: opomena pred utuženje — fizičko lice, predlog odluke (D+60)',
     '{"trigger":{"type":"days_from_due","offset":60},
       "conditions":[{"field":"policy","op":"eq","value":"standard"},{"field":"is_natural_person","op":"eq","value":true}],
       "actions":[{"type":"create_decision","decisionType":"pre_litigation_notice"}]}'),
    ('std_legal_d90', 'Standard: predlog predaje pravnoj službi (D+90)',
     '{"trigger":{"type":"days_from_due","offset":90},
       "conditions":[{"field":"policy","op":"eq","value":"standard"}],
       "actions":[{"type":"create_case","priority":"urgent"},{"type":"create_approval","approval":"case.legal_handover"}]}')
  ) AS v(key, name, definition) LOOP
    INSERT INTO workflows (tenant_id, key, name) VALUES (t, w.key, w.name)
    ON CONFLICT (tenant_id, key) DO NOTHING RETURNING id INTO wid;
    IF wid IS NOT NULL THEN
      INSERT INTO workflow_versions (tenant_id, workflow_id, version, status, definition, provisioned, published_at)
      VALUES (t, wid, 1, 'published', w.definition::jsonb, true, now());
    END IF;
  END LOOP;

  -- Default templates (3.2): metadata in templates, texts per locale in template_texts. Tenant-editable;
  -- legal formulations per country belong to country profiles (BACKLOG).
  FOR tpl IN SELECT * FROM (VALUES
    ('reminder_before_due', 'email', 'Podsetnik pre dospeća', false, 'Podsetnik: faktura {{invoice.number}} dospeva {{invoice.due_date}}', '<p>Poštovani,</p><p>podsećamo da faktura {{invoice.number}} na iznos {{invoice.amount_open}} dospeva {{invoice.due_date}}.</p><p>Ako ste je već platili, zanemarite ovu poruku.</p><p>{{collector.name}}<br>{{company.name}}</p>', 'Reminder: invoice {{invoice.number}} is due on {{invoice.due_date}}', '<p>Dear customer,</p><p>this is a reminder that invoice {{invoice.number}} for {{invoice.amount_open}} is due on {{invoice.due_date}}.</p><p>If you have already paid, please ignore this message.</p><p>{{collector.name}}<br>{{company.name}}</p>'),
    ('reminder_overdue', 'email', 'Podsetnik — dospelo', false, 'Faktura {{invoice.number}} je dospela', '<p>Poštovani,</p><p>faktura {{invoice.number}} na iznos {{invoice.amount_open}} dospela je {{invoice.due_date}} i još nije plaćena.</p><p>Molimo vas da je platite ili nam javite očekivani datum plaćanja.</p><p>{{collector.name}}<br>{{company.name}}</p>', 'Invoice {{invoice.number}} is overdue', '<p>Dear customer,</p><p>invoice {{invoice.number}} for {{invoice.amount_open}} was due on {{invoice.due_date}} and is still unpaid.</p><p>Please pay it or let us know when to expect the payment.</p><p>{{collector.name}}<br>{{company.name}}</p>'),
    ('reminder_second', 'email', 'Drugi podsetnik', false, 'Drugi podsetnik: dospeli dug {{customer.overdue_total}}', '<p>Poštovani,</p><p>ukupan dospeli dug iznosi {{customer.overdue_total}}. Fakture:</p><ul>{{#invoices}}<li>{{invoice.number}} — {{invoice.amount_open}}, dospeće {{invoice.due_date}} ({{invoice.days_overdue}} dana)</li>{{/invoices}}</ul><p>{{collector.name}}<br>{{company.name}}</p>', 'Second reminder: overdue debt {{customer.overdue_total}}', '<p>Dear customer,</p><p>your total overdue debt is {{customer.overdue_total}}. Invoices:</p><ul>{{#invoices}}<li>{{invoice.number}} — {{invoice.amount_open}}, due {{invoice.due_date}} ({{invoice.days_overdue}} days)</li>{{/invoices}}</ul><p>{{collector.name}}<br>{{company.name}}</p>'),
    ('pre_litigation_notice', 'email', 'Opomena pred utuženje', true, 'Opomena pred utuženje — {{customer.name}}', '<p>Poštovani,</p><p>i pored ranijih opomena, dug od {{customer.overdue_total}} nije izmiren. Ukoliko dug ne bude izmiren u roku od 8 dana, pokrenućemo postupak naplate pred nadležnim sudom.</p><p>{{collector.name}}<br>{{company.name}}</p>', 'Notice before legal action — {{customer.name}}', '<p>Dear customer,</p><p>despite earlier reminders, the debt of {{customer.overdue_total}} remains unpaid. Unless it is settled within 8 days, we will start court proceedings.</p><p>{{collector.name}}<br>{{company.name}}</p>'),
    ('dunning_letter', 'document', 'Opomena', false, 'Opomena', '<h1>Opomena</h1><p>{{company.name}}, PIB {{company.tax_id}}</p><p>Kupac: {{customer.name}}, PIB {{customer.tax_id}}</p><p>Datum: {{today}}</p><p>Na dan {{today}} evidentiramo sledeće dospele nenaplaćene fakture:</p><table><thead><tr><th>Faktura</th><th>Dospeće</th><th>Dana</th><th>Iznos</th></tr></thead><tbody>{{#invoices}}<tr><td>{{invoice.number}}</td><td>{{invoice.due_date}}</td><td>{{invoice.days_overdue}}</td><td>{{invoice.amount_open}}</td></tr>{{/invoices}}</tbody></table><p><strong>Ukupno dospelo: {{customer.overdue_total}}</strong></p><p>Molimo vas da dug izmirite u najkraćem roku.</p><p>{{collector.name}}</p>', 'Payment reminder', '<h1>Payment reminder</h1><p>{{company.name}}, tax ID {{company.tax_id}}</p><p>Customer: {{customer.name}}, tax ID {{customer.tax_id}}</p><p>Date: {{today}}</p><p>As of {{today}} the following invoices are overdue and unpaid:</p><table><thead><tr><th>Invoice</th><th>Due</th><th>Days</th><th>Amount</th></tr></thead><tbody>{{#invoices}}<tr><td>{{invoice.number}}</td><td>{{invoice.due_date}}</td><td>{{invoice.days_overdue}}</td><td>{{invoice.amount_open}}</td></tr>{{/invoices}}</tbody></table><p><strong>Total overdue: {{customer.overdue_total}}</strong></p><p>Please settle the debt as soon as possible.</p><p>{{collector.name}}</p>'),
    ('statement', 'document', 'Izvod otvorenih stavki (IOS)', false, 'Izvod otvorenih stavki', '<h1>Izvod otvorenih stavki</h1><p>{{company.name}}, PIB {{company.tax_id}}</p><p>Kupac: {{customer.name}}, PIB {{customer.tax_id}}</p><p>Stanje na dan {{today}}:</p><table><thead><tr><th>Faktura</th><th>Datum</th><th>Dospeće</th><th>Iznos</th><th>Otvoreno</th></tr></thead><tbody>{{#invoices}}<tr><td>{{invoice.number}}</td><td>{{invoice.issue_date}}</td><td>{{invoice.due_date}}</td><td>{{invoice.amount_total}}</td><td>{{invoice.amount_open}}</td></tr>{{/invoices}}</tbody></table><p><strong>Ukupno otvoreno: {{customer.open_total}}</strong></p><p>Molimo vas da stanje potvrdite ili osporite u roku od 8 dana.</p>', 'Statement of open items', '<h1>Statement of open items</h1><p>{{company.name}}, tax ID {{company.tax_id}}</p><p>Customer: {{customer.name}}, tax ID {{customer.tax_id}}</p><p>Balance as of {{today}}:</p><table><thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>Open</th></tr></thead><tbody>{{#invoices}}<tr><td>{{invoice.number}}</td><td>{{invoice.issue_date}}</td><td>{{invoice.due_date}}</td><td>{{invoice.amount_total}}</td><td>{{invoice.amount_open}}</td></tr>{{/invoices}}</tbody></table><p><strong>Total open: {{customer.open_total}}</strong></p><p>Please confirm or dispute this balance within 8 days.</p>')
  ) AS v(key, channel, name, legal, sr_subject, sr_body, en_subject, en_body) LOOP
    INSERT INTO templates (tenant_id, key, channel, name, version, has_legal_effect)
    VALUES (t, tpl.key, tpl.channel, tpl.name, 1, tpl.legal)
    ON CONFLICT (tenant_id, key, channel, version) DO NOTHING RETURNING id INTO tid;
    IF tid IS NOT NULL THEN
      INSERT INTO template_texts (tenant_id, template_id, locale, subject, body)
      VALUES (t, tid, 'sr-Latn', tpl.sr_subject, tpl.sr_body), (t, tid, 'en', tpl.en_subject, tpl.en_body);
    END IF;
  END LOOP;
END $$;

-- Every caller of provision_receivables_defaults() (seed, e2e, golden fixtures) gets them too.
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
END $$;

-- ============================================================================================
-- Row Level Security, grants, PII registry
-- ============================================================================================

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflows
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_versions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_runs
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE workflow_run_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow_run_actions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tasks
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Workflows are archived, versions superseded, runs and their actions are history.
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON templates
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE template_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON template_texts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

REVOKE DELETE, TRUNCATE ON templates FROM vigor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON template_texts FROM vigor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON documents FROM vigor_app;
REVOKE DELETE, TRUNCATE ON workflows, workflow_versions FROM vigor_app;
REVOKE DELETE, TRUNCATE ON workflow_runs FROM vigor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON workflow_run_actions FROM vigor_app;
REVOKE DELETE, TRUNCATE ON tasks, notifications FROM vigor_app;

-- Documents: metadata is P0; the content (in storage, encrypted) names the customer.
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'document metadata (registered by 016)'
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.table_name = 'documents'
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 016)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('workflows', 'workflow_versions', 'workflow_runs', 'workflow_run_actions',
                        'tasks', 'notifications', 'templates', 'template_texts')
       OR (c.table_name, c.column_name) IN (('tenant_settings', 'default_policy_code'),
                                            ('tenant_settings', 'attention_no_activity_days'),
                                            ('tenant_settings', 'attention_large_overdue'),
                                            ('customers', 'policy_list_key'), ('customers', 'policy_code'),
                                            ('collection_cases', 'workflow_version_id'),
                                            ('decisions', 'case_id'), ('decisions', 'source_run_id')))
ON CONFLICT (table_name, column_name) DO NOTHING;
