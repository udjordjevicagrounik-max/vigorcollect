-- 012_receivables_up.sql — Sprint 2, task 2.1: receivables (invoices, payments, allocations),
-- promises, activities, collection cases; tenant domain defaults (aging buckets, case stages,
-- promise grace, DSO window) as configuration, never code. Applied by scripts/migrate.sh as
-- vigor_migrate in one transaction. Protected file (rule 13).
--
-- Money (rule 18): numeric(18,2) + explicit currency on every amount; FX of a document is frozen
-- (fx_rate, fx_rate_date, fx_source — once set, never rewritten). Dates without time are `date`
-- (rule 26). amount_open is DERIVED: amount_total − Σ allocations, recomputed by trigger on every
-- write — a manual value is overwritten, never stored.

-- ============================================================================================
-- Tenant domain settings (configurable defaults)
-- ============================================================================================

ALTER TABLE tenant_settings
  ADD COLUMN promise_grace_days integer NOT NULL DEFAULT 1 CHECK (promise_grace_days BETWEEN 0 AND 30),
  ADD COLUMN dso_window_days integer NOT NULL DEFAULT 90 CHECK (dso_window_days BETWEEN 30 AND 365),
  ADD COLUMN allocation_strategy text NOT NULL DEFAULT 'fifo_due'
    CHECK (allocation_strategy IN ('fifo_due'));

-- Aging bucket bounds per tenant; the bucket itself is a code_lists entry ('aging_bucket').
CREATE TABLE aging_bucket_bounds (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants (id),
  list_key          text        NOT NULL GENERATED ALWAYS AS ('aging_bucket') STORED,
  code              text        NOT NULL,
  min_days_overdue  integer     NOT NULL CHECK (min_days_overdue >= 0),
  max_days_overdue  integer     CHECK (max_days_overdue IS NULL OR max_days_overdue >= min_days_overdue),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid,
  CONSTRAINT aging_bucket_bounds_code FOREIGN KEY (tenant_id, list_key, code)
    REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT aging_bucket_bounds_unique UNIQUE (tenant_id, code)
);

-- ============================================================================================
-- Invoices (EN 16931 core — rule 25)
-- ============================================================================================

CREATE TABLE invoices (
  id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid           NOT NULL REFERENCES tenants (id),
  company_id         uuid           NOT NULL,
  customer_id        uuid           NOT NULL,
  source_id          uuid           NOT NULL,
  external_id        text           NOT NULL CHECK (external_id <> '' AND length(external_id) <= 200),
  number             text           NOT NULL CHECK (number <> '' AND length(number) <= 100),   -- BT-1
  invoice_type_code  text           NOT NULL DEFAULT '380' CHECK (invoice_type_code ~ '^[0-9]{3}$'), -- BT-3
  issue_date         date           NOT NULL,                                                  -- BT-2
  due_date           date           NOT NULL,                                                  -- BT-9
  currency           char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),                  -- BT-5
  amount_net         numeric(18,2)  CHECK (amount_net >= 0),                                   -- BT-109
  amount_tax         numeric(18,2)  CHECK (amount_tax >= 0),                                   -- BT-110
  amount_total       numeric(18,2)  NOT NULL CHECK (amount_total > 0),                         -- BT-112
  amount_open        numeric(18,2)  NOT NULL CHECK (amount_open >= 0),                         -- derived
  buyer_reference    text           CHECK (buyer_reference <> ''),                             -- BT-10
  order_reference    text           CHECK (order_reference <> ''),                             -- BT-13
  payment_terms      text           CHECK (payment_terms <> ''),                               -- BT-20
  fx_rate            numeric(20,10) CHECK (fx_rate > 0),
  fx_rate_date       date,
  fx_source          text           CHECK (fx_source ~ '^[A-Z]{2,10}$'),
  accounting_status  text           NOT NULL DEFAULT 'open'
                                    CHECK (accounting_status IN ('open', 'partially_paid', 'paid', 'credited', 'cancelled')),
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  CONSTRAINT invoices_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT invoices_source_external UNIQUE (tenant_id, source_id, external_id),
  CONSTRAINT invoices_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_companies (tenant_id, id),
  CONSTRAINT invoices_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT invoices_source FOREIGN KEY (tenant_id, source_id) REFERENCES data_sources (tenant_id, id),
  CONSTRAINT invoices_due_after_issue CHECK (due_date >= issue_date),
  CONSTRAINT invoices_fx_all_or_none
    CHECK ((fx_rate IS NULL) = (fx_rate_date IS NULL) AND (fx_rate IS NULL) = (fx_source IS NULL)),
  CONSTRAINT invoices_net_tax_total
    CHECK (amount_net IS NULL OR amount_tax IS NULL OR amount_net + amount_tax = amount_total)
);
CREATE INDEX invoices_customer_due ON invoices (tenant_id, customer_id, due_date);
CREATE INDEX invoices_open_due ON invoices (tenant_id, due_date) WHERE amount_open > 0;

-- ============================================================================================
-- Payments and allocations
-- ============================================================================================

-- kind 'received' = money from the customer; 'source_settlement' = the source system (ERP)
-- reports an invoice as (partly) settled without the payment itself — an allocation keeps
-- amount_open derived instead of being rewritten (import, 2.2).
CREATE TABLE payments (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid           NOT NULL REFERENCES tenants (id),
  customer_id   uuid           NOT NULL,
  source_id     uuid           NOT NULL,
  external_id   text           CHECK (external_id <> '' AND length(external_id) <= 200),
  kind          text           NOT NULL DEFAULT 'received' CHECK (kind IN ('received', 'source_settlement')),
  paid_on       date           NOT NULL,
  amount        numeric(18,2)  NOT NULL CHECK (amount > 0),
  currency      char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference     text           CHECK (reference <> '' AND length(reference) <= 200),
  fx_rate       numeric(20,10) CHECK (fx_rate > 0),
  fx_rate_date  date,
  fx_source     text           CHECK (fx_source ~ '^[A-Z]{2,10}$'),
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  CONSTRAINT payments_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT payments_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT payments_source FOREIGN KEY (tenant_id, source_id) REFERENCES data_sources (tenant_id, id),
  CONSTRAINT payments_fx_all_or_none
    CHECK ((fx_rate IS NULL) = (fx_rate_date IS NULL) AND (fx_rate IS NULL) = (fx_source IS NULL))
);
CREATE UNIQUE INDEX payments_source_external ON payments (tenant_id, source_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX payments_customer_paid ON payments (tenant_id, customer_id, paid_on);

CREATE TABLE payment_allocations (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid           NOT NULL REFERENCES tenants (id),
  payment_id   uuid           NOT NULL,
  invoice_id   uuid           NOT NULL,
  amount       numeric(18,2)  NOT NULL CHECK (amount > 0),
  method       text           NOT NULL CHECK (method IN ('fifo', 'explicit', 'source')),
  created_at   timestamptz    NOT NULL DEFAULT now(),
  created_by   uuid,
  CONSTRAINT payment_allocations_payment FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
  CONSTRAINT payment_allocations_invoice FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CONSTRAINT payment_allocations_unique UNIQUE (tenant_id, payment_id, invoice_id)
);
CREATE INDEX payment_allocations_invoice ON payment_allocations (tenant_id, invoice_id);

-- ============================================================================================
-- Collection cases, promises, activities
-- ============================================================================================

CREATE TABLE collection_cases (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id),
  customer_id          uuid        NOT NULL,
  owner_user_id        uuid,
  stage_list_key       text        NOT NULL GENERATED ALWAYS AS ('case_stage') STORED,
  stage_code           text        NOT NULL,
  status               text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  priority             text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  -- Rule 11: the 'legal' stage needs an approved legal-handover request.
  legal_approval_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  CONSTRAINT collection_cases_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT collection_cases_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT collection_cases_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT collection_cases_stage FOREIGN KEY (tenant_id, stage_list_key, stage_code)
    REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT collection_cases_legal_approval
    FOREIGN KEY (tenant_id, legal_approval_id) REFERENCES approval_requests (tenant_id, id),
  CONSTRAINT collection_cases_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT collection_cases_legal_needs_approval CHECK (stage_code <> 'legal' OR legal_approval_id IS NOT NULL)
);
CREATE INDEX collection_cases_customer ON collection_cases (tenant_id, customer_id);
CREATE INDEX collection_cases_owner_open ON collection_cases (tenant_id, owner_user_id) WHERE status = 'open';

CREATE TABLE case_invoices (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  case_id     uuid        NOT NULL,
  invoice_id  uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT case_invoices_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT case_invoices_invoice FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CONSTRAINT case_invoices_unique UNIQUE (tenant_id, case_id, invoice_id)
);
CREATE INDEX case_invoices_invoice ON case_invoices (tenant_id, invoice_id);

CREATE TABLE promises (
  id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid           NOT NULL REFERENCES tenants (id),
  customer_id      uuid           NOT NULL,
  case_id          uuid,
  company_id       uuid           NOT NULL,   -- its time zone decides "D+1" (rule 26)
  amount           numeric(18,2)  NOT NULL CHECK (amount > 0),
  currency         char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  promised_on      date           NOT NULL,
  made_on          date           NOT NULL,
  status           text           NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'fulfilled', 'partial', 'broken', 'cancelled')),
  paid_amount      numeric(18,2)  CHECK (paid_amount >= 0),
  evaluated_at     timestamptz,
  created_at       timestamptz    NOT NULL DEFAULT now(),
  updated_at       timestamptz    NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  CONSTRAINT promises_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT promises_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT promises_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT promises_company FOREIGN KEY (tenant_id, company_id) REFERENCES tenant_companies (tenant_id, id),
  CONSTRAINT promises_dates CHECK (promised_on >= made_on),
  CONSTRAINT promises_evaluated
    CHECK ((status IN ('fulfilled', 'partial', 'broken')) = (evaluated_at IS NOT NULL AND paid_amount IS NOT NULL))
);
CREATE INDEX promises_due ON promises (tenant_id, promised_on) WHERE status = 'pending';
CREATE INDEX promises_customer ON promises (tenant_id, customer_id);

-- Contact log. The note is free text → encrypted per customer (ADR 0003). Append-only.
CREATE TABLE activities (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenants (id),
  customer_id           uuid        NOT NULL,
  case_id               uuid,
  kind                  text        NOT NULL CHECK (kind IN ('call', 'email', 'note', 'meeting')),
  outcome_list_key      text        NOT NULL GENERATED ALWAYS AS ('activity_outcome') STORED,
  outcome_code          text,
  next_action_list_key  text        NOT NULL GENERATED ALWAYS AS ('next_action') STORED,
  next_action_code      text,
  next_action_on        date,
  note_enc              bytea,
  note_key_version      integer     CHECK (note_key_version >= 1),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  actor_user_id         uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  CONSTRAINT activities_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT activities_customer FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT activities_case FOREIGN KEY (tenant_id, case_id) REFERENCES collection_cases (tenant_id, id),
  CONSTRAINT activities_actor FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT activities_outcome FOREIGN KEY (tenant_id, outcome_list_key, outcome_code)
    REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT activities_next_action FOREIGN KEY (tenant_id, next_action_list_key, next_action_code)
    REFERENCES code_lists (tenant_id, list_key, code),
  CONSTRAINT activities_note_pair CHECK ((note_enc IS NULL) = (note_key_version IS NULL)),
  CONSTRAINT activities_next_action_pair CHECK (next_action_on IS NULL OR next_action_code IS NOT NULL)
);
CREATE INDEX activities_customer ON activities (tenant_id, customer_id, occurred_at DESC);
CREATE INDEX activities_next_action ON activities (tenant_id, next_action_on) WHERE next_action_on IS NOT NULL;

-- ============================================================================================
-- Triggers: derived amount_open, frozen FX, allocation limits
-- ============================================================================================

-- amount_open = amount_total − Σ allocations; status follows unless credited/cancelled.
CREATE FUNCTION invoices_derive() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  allocated numeric(18,2);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.fx_rate IS NOT NULL AND (
       NEW.fx_rate IS DISTINCT FROM OLD.fx_rate OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
       OR NEW.fx_source IS DISTINCT FROM OLD.fx_source) THEN
    RAISE EXCEPTION 'invoices: the frozen exchange rate is never rewritten (rule 18)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'invoices: currency is fixed' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(a.amount), 0) INTO allocated FROM payment_allocations a
  WHERE a.tenant_id = NEW.tenant_id AND a.invoice_id = NEW.id;
  NEW.amount_open := NEW.amount_total - allocated;
  IF NEW.amount_open < 0 THEN
    RAISE EXCEPTION 'invoices: allocations exceed the invoice total' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.accounting_status NOT IN ('credited', 'cancelled') THEN
    NEW.accounting_status := CASE
      WHEN NEW.amount_open = 0 THEN 'paid'
      WHEN NEW.amount_open < NEW.amount_total THEN 'partially_paid'
      ELSE 'open' END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_derive BEFORE INSERT OR UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_derive();

CREATE FUNCTION payments_fx_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.fx_rate IS NOT NULL AND (
       NEW.fx_rate IS DISTINCT FROM OLD.fx_rate OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
       OR NEW.fx_source IS DISTINCT FROM OLD.fx_source) THEN
    RAISE EXCEPTION 'payments: the frozen exchange rate is never rewritten (rule 18)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'payments: amount, currency and customer are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_fx_frozen BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_fx_frozen();

-- Money received is never deleted (a reversal is a new document). Only a source settlement that
-- no longer settles anything may go — import rollback (2.2) removes what its run created.
CREATE FUNCTION payments_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.kind <> 'source_settlement' OR EXISTS (
       SELECT 1 FROM payment_allocations a WHERE a.tenant_id = OLD.tenant_id AND a.payment_id = OLD.id) THEN
    RAISE EXCEPTION 'payments: only an unallocated source settlement can be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER payments_delete_guard BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_delete_guard();

-- Σ allocations ≤ payment.amount; same customer and currency; then the invoice recomputes.
CREATE FUNCTION payment_allocations_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  pay payments%ROWTYPE;
  inv_customer uuid;
  inv_currency char(3);
  used numeric(18,2);
BEGIN
  SELECT * INTO pay FROM payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id FOR UPDATE;
  SELECT customer_id, currency INTO inv_customer, inv_currency FROM invoices
  WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
  IF inv_customer IS DISTINCT FROM pay.customer_id THEN
    RAISE EXCEPTION 'payment_allocations: invoice and payment belong to different customers'
      USING ERRCODE = 'check_violation';
  END IF;
  IF inv_currency IS DISTINCT FROM pay.currency THEN
    RAISE EXCEPTION 'payment_allocations: currencies differ' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations
  WHERE tenant_id = NEW.tenant_id AND payment_id = NEW.payment_id AND id <> NEW.id;
  IF used + NEW.amount > pay.amount THEN
    RAISE EXCEPTION 'payment_allocations: allocations exceed the payment amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION payment_allocations_touch_invoice() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  -- The UPDATE fires invoices_derive, which recomputes amount_open from the allocations.
  UPDATE invoices SET updated_at = now()
  WHERE tenant_id = coalesce(NEW.tenant_id, OLD.tenant_id) AND id = coalesce(NEW.invoice_id, OLD.invoice_id);
  RETURN NULL;
END $$;

CREATE TRIGGER payment_allocations_check BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_check();
CREATE TRIGGER payment_allocations_touch AFTER INSERT OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_touch_invoice();

CREATE TRIGGER aging_bucket_bounds_updated_at BEFORE UPDATE ON aging_bucket_bounds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER collection_cases_updated_at BEFORE UPDATE ON collection_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER promises_updated_at BEFORE UPDATE ON promises
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Row Level Security + grants
-- ============================================================================================

ALTER TABLE aging_bucket_bounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE aging_bucket_bounds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON aging_bucket_bounds
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_allocations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE collection_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON collection_cases
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE case_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON case_invoices
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE promises ENABLE ROW LEVEL SECURITY;
ALTER TABLE promises FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON promises
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activities
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Payments are never re-valued and only unallocated source settlements are deleted (trigger
-- payments_delete_guard); allocations are inserted
-- or removed, never edited; cases and promises close / cancel by status; activities are a log.
REVOKE DELETE, TRUNCATE ON collection_cases, promises FROM vigor_app;
REVOKE TRUNCATE ON payments FROM vigor_app;
REVOKE UPDATE, TRUNCATE ON payment_allocations FROM vigor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON activities FROM vigor_app;
REVOKE TRUNCATE ON invoices, case_invoices, aging_bucket_bounds FROM vigor_app;

-- ============================================================================================
-- FX rates: written only by fxRatesJob (rule 18) through this function — never the app
-- ============================================================================================

CREATE FUNCTION fx_rates_upsert(p_source text, p_base char(3), p_quote char(3), p_rate numeric,
                                p_valid_on date) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO exchange_rates (source, base_currency, quote_currency, rate, valid_on)
  VALUES (p_source, p_base, p_quote, p_rate, p_valid_on)
  ON CONFLICT (source, base_currency, quote_currency, valid_on) DO NOTHING;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION fx_rates_upsert(text, char, char, numeric, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fx_rates_upsert(text, char, char, numeric, date) TO vigor_worker;

-- ============================================================================================
-- Tenant defaults (configurable; run inside the tenant's context — seed, provisioning)
-- ============================================================================================

CREATE FUNCTION provision_receivables_defaults() RETURNS void
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
    ('next_action', 'check_payment', 3)
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
    ('next_action.check_payment', 'sr-Latn', 'Proveri uplatu'), ('next_action.check_payment', 'en', 'Check payment')
  ) AS v(k, loc, txt)
  ON CONFLICT (tenant_id, entity_type, entity_key, field, locale) DO NOTHING;
END $$;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('activities', 'note_enc', 'P1', NULL, NULL, true, NULL, 'free-text contact note'),
  ('payments', 'reference', 'P0', 'customers.is_natural_person = true', 'P1', false,
   'payment reference from the bank statement; shown to collectors to match payments',
   'payment matching'),
  ('invoices', 'buyer_reference', 'P0', 'customers.is_natural_person = true', 'P1', false,
   'buyer reference on the invoice (EN 16931 BT-10)', 'invoice matching');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 012)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('aging_bucket_bounds', 'invoices', 'payments', 'payment_allocations',
                        'collection_cases', 'case_invoices', 'promises', 'activities')
       OR (c.table_name, c.column_name) IN (('tenant_settings', 'promise_grace_days'),
                                            ('tenant_settings', 'dso_window_days'),
                                            ('tenant_settings', 'allocation_strategy')))
ON CONFLICT (table_name, column_name) DO NOTHING;
