-- 027_custom_fields_up.sql — Sprint 6.1: custom fields on customers, contacts, invoices, cases.
-- Protected (rule 13). Additive; one CHECK (translations.entity_type) replaced by a superset under
-- the same name (ADR 0003, "Zamena CHECK-a").
--
-- custom_field_definitions: per tenant and entity, key immutable (slug), type immutable, status
--   active / archived — never deleted (values keep their history). pii_class is mandatory
--   (rule 20); P1+ fields are encrypted (value_text_enc, subject key of the entity's customer or
--   contact) and can never be filterable. Every definition gets its own pii_field_registry row
--   (table custom_field_values, column 'cf:<definition id>' — no tenant data in the name) through
--   a SECURITY DEFINER trigger, because vigor_app may only read the platform registry.
-- custom_field_values: typed columns (rule 15 — no jsonb), one row per entity and field.
-- user_list_columns: which custom columns a member shows in a list (on/off per member).

ALTER TABLE tenant_settings
  ADD COLUMN custom_fields_max integer NOT NULL DEFAULT 30 CHECK (custom_fields_max BETWEEN 1 AND 100);

-- Labels of custom fields live in translations (entity_key '<entity>.<key>', rule 17).
ALTER TABLE translations DROP CONSTRAINT translations_entity_type_check;
ALTER TABLE translations ADD CONSTRAINT translations_entity_type_check
  CHECK (entity_type IN ('role', 'code_list', 'custom_field'));

CREATE TABLE custom_field_definitions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id),
  entity_type     text        NOT NULL CHECK (entity_type IN ('customer', 'contact', 'invoice', 'case')),
  key             text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  type            text        NOT NULL CHECK (type IN ('text', 'number', 'date', 'bool', 'select',
                                                       'multiselect', 'currency')),
  -- select / multiselect: options are the code list 'cf_<entity>_<key>' (labels in translations).
  options_list_key text       GENERATED ALWAYS AS (
                                CASE WHEN type IN ('select', 'multiselect') THEN 'cf_' || entity_type || '_' || key END) STORED,
  required        boolean     NOT NULL DEFAULT false,
  filterable      boolean     NOT NULL DEFAULT false,
  show_in_list    boolean     NOT NULL DEFAULT false,
  position        integer     NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pii_class       text        NOT NULL CHECK (pii_class IN ('P0', 'P1', 'P2', 'P3')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT custom_field_definitions_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT custom_field_definitions_key UNIQUE (tenant_id, entity_type, key),
  -- Rule 20: an encrypted (P1+) value is never compared in SQL, so never filterable; only text
  -- can carry personal data (numbers, dates, options and booleans are P0).
  CONSTRAINT custom_field_definitions_pii CHECK (pii_class = 'P0' OR (type = 'text' AND NOT filterable))
);
CREATE TRIGGER custom_field_definitions_updated_at BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- key, entity, type and class never change (values and the registry depend on them).
CREATE FUNCTION custom_field_definitions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.key <> OLD.key OR NEW.entity_type <> OLD.entity_type OR NEW.type <> OLD.type
     OR NEW.pii_class <> OLD.pii_class OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'custom field key, entity, type and pii_class are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_field_definitions_immutable BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION custom_field_definitions_guard();

-- Rule 20: the registry row of a new field (platform table → SECURITY DEFINER).
CREATE FUNCTION custom_field_register_pii() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, purpose)
  VALUES ('custom_field_values', 'cf:' || NEW.id::text, NEW.pii_class, NEW.pii_class <> 'P0',
          'custom field (' || NEW.entity_type || ', ' || NEW.type || ')')
  ON CONFLICT (table_name, column_name) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION custom_field_register_pii() FROM PUBLIC;
CREATE TRIGGER custom_field_definitions_registry AFTER INSERT ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION custom_field_register_pii();

CREATE TABLE custom_field_values (
  id                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid           NOT NULL REFERENCES tenants (id),
  field_id               uuid           NOT NULL,
  entity_type            text           NOT NULL CHECK (entity_type IN ('customer', 'contact', 'invoice', 'case')),
  entity_id              uuid           NOT NULL,
  value_text             text           CHECK (length(value_text) <= 2000),
  value_numeric          numeric(18,2),
  value_currency         char(3)        CHECK (value_currency ~ '^[A-Z]{3}$'),
  value_date             date,
  value_bool             boolean,
  value_option_code      text           CHECK (value_option_code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  value_option_codes     text[]         CHECK (cardinality(value_option_codes) <= 50),
  value_text_enc         bytea,
  value_text_key_version integer        CHECK (value_text_key_version >= 1),
  created_at             timestamptz    NOT NULL DEFAULT now(),
  updated_at             timestamptz    NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,
  CONSTRAINT custom_field_values_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT custom_field_values_one UNIQUE (tenant_id, entity_type, entity_id, field_id),
  CONSTRAINT custom_field_values_field FOREIGN KEY (tenant_id, field_id)
    REFERENCES custom_field_definitions (tenant_id, id),
  CONSTRAINT custom_field_values_enc_pair CHECK ((value_text_enc IS NULL) = (value_text_key_version IS NULL)),
  CONSTRAINT custom_field_values_currency_pair CHECK (value_currency IS NULL OR value_numeric IS NOT NULL)
);
CREATE TRIGGER custom_field_values_updated_at BEFORE UPDATE ON custom_field_values
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX custom_field_values_entity ON custom_field_values (tenant_id, entity_type, entity_id);
CREATE INDEX custom_field_values_text ON custom_field_values (tenant_id, field_id, value_text) WHERE value_text IS NOT NULL;
CREATE INDEX custom_field_values_numeric ON custom_field_values (tenant_id, field_id, value_numeric) WHERE value_numeric IS NOT NULL;
CREATE INDEX custom_field_values_date ON custom_field_values (tenant_id, field_id, value_date) WHERE value_date IS NOT NULL;
CREATE INDEX custom_field_values_option ON custom_field_values (tenant_id, field_id, value_option_code) WHERE value_option_code IS NOT NULL;
CREATE INDEX custom_field_values_options ON custom_field_values USING gin (value_option_codes) WHERE value_option_codes IS NOT NULL;

CREATE TABLE user_list_columns (
  tenant_id   uuid        NOT NULL REFERENCES tenants (id),
  user_id     uuid        NOT NULL,
  list_key    text        NOT NULL CHECK (list_key IN ('customers', 'invoices')),
  field_ids   uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(field_ids) <= 30),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, list_key),
  CONSTRAINT user_list_columns_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER user_list_columns_updated_at BEFORE UPDATE ON user_list_columns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_field_definitions
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_field_values
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
ALTER TABLE user_list_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_list_columns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_list_columns
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Definitions are archived, never deleted (history of values).
REVOKE DELETE, TRUNCATE ON custom_field_definitions FROM vigor_app;
REVOKE TRUNCATE ON custom_field_values, user_list_columns FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, encrypted, purpose)
VALUES ('custom_field_values', 'value_text_enc', 'P1', true, 'custom field value of a P1+ field (sealed)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('custom_field_values', 'value_text', 'P0', 'text of a P0 custom field only (P1+ text goes to value_text_enc)');
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 027)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('custom_field_definitions', 'custom_field_values', 'user_list_columns')
  AND NOT (c.table_name = 'custom_field_values' AND c.column_name IN ('value_text_enc', 'value_text'));
INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
VALUES ('tenant_settings', 'custom_fields_max', 'P0', 'not personal data (registered by 027)');
