-- 002_customers_subject_keys_up.sql — Schema v1, part 0.2b.
-- Per-subject encryption keys (rule 20, ADR 0003), customers as TenantPartyRelationship
-- (rule 30), customer contacts with encrypted PII and a per-tenant blind index (rule 33),
-- user_roles.scope (ADR 0002, decision 1), find_or_create_legal_entity() and the extension of
-- the legal_entities read policy to customers. NO financial tables.
-- Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file (rule 13).
--
-- Conventions as in 001 (docs/schema-v1.md). Additionally (ADR 0003):
--   * Encrypted field = <field>_enc bytea + <field>_key_version integer, set together.
--     Ciphertext is produced by src/server/crypto (AES-256-GCM); the database never sees
--     plaintext or keys.
--   * Blind index = <field>_bidx bytea + <field>_bidx_key_version integer: HMAC-SHA256 with a
--     key of the TENANT (never global), so the same value in two tenants gives two indexes.

-- ============================================================================================
-- Registry: documented exceptions (P1+ stored unencrypted on purpose)
-- ============================================================================================

ALTER TABLE pii_field_registry ADD COLUMN exception_reason text CHECK (exception_reason <> '');

-- ============================================================================================
-- subject_keys — wrapped data keys per data subject (and the per-tenant blind index key)
-- ============================================================================================

-- A data key is random (32 bytes), wrapped with the master key from the environment
-- (PII_MASTER_KEYS, never in the database or in backups — rule 28). Crypto-shredding of a
-- subject = status 'destroyed' + wrapped_key NULL (erasure flow, later task).
CREATE TABLE subject_keys (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id),
  subject_type        text        NOT NULL CHECK (subject_type IN ('tenant', 'customer', 'customer_contact')),
  subject_id          uuid        NOT NULL,
  purpose             text        NOT NULL CHECK (purpose IN ('data', 'blind_index')),
  key_version         integer     NOT NULL CHECK (key_version >= 1),
  master_key_version  integer     NOT NULL CHECK (master_key_version >= 1),
  wrapped_key         bytea,
  status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'destroyed')),
  destroyed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  CONSTRAINT subject_keys_version_unique
    UNIQUE (tenant_id, subject_type, subject_id, purpose, key_version),
  -- The blind index key belongs to the tenant itself; data keys belong to a person.
  CONSTRAINT subject_keys_purpose_subject
    CHECK ((purpose = 'blind_index') = (subject_type = 'tenant')),
  CONSTRAINT subject_keys_tenant_subject
    CHECK (subject_type <> 'tenant' OR subject_id = tenant_id),
  CONSTRAINT subject_keys_destroyed
    CHECK ((status = 'destroyed') = (wrapped_key IS NULL)
           AND (status = 'destroyed') = (destroyed_at IS NOT NULL))
);
-- Exactly one active key per subject and purpose (rotation inserts version n+1, retires n).
CREATE UNIQUE INDEX subject_keys_single_active
  ON subject_keys (tenant_id, subject_type, subject_id, purpose) WHERE status = 'active';

-- ============================================================================================
-- customers — TenantPartyRelationship (rule 30)
-- ============================================================================================

-- Tenant attributes of the relationship with a canonical legal entity. Financial data stays
-- tenant-owned in later tables. A natural person's display name is stored ONLY encrypted
-- (rule 20); companies keep the plaintext name (not personal data, searchable).
CREATE TABLE customers (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenants (id),
  legal_entity_id          uuid        NOT NULL REFERENCES legal_entities (id),
  relationship_type        text        NOT NULL DEFAULT 'customer'
                                       CHECK (relationship_type IN ('customer', 'supplier', 'both')),
  is_natural_person        boolean     NOT NULL DEFAULT false,
  display_name             text        CHECK (display_name <> ''),
  display_name_enc         bytea,
  display_name_key_version integer     CHECK (display_name_key_version >= 1),
  external_id              text        CHECK (external_id <> ''),
  segment_code             text        CHECK (segment_code ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  -- OWN scope is evaluated against this column. TEAM scope behaves as OWN until teams exist (1.4).
  owner_user_id            uuid,
  status                   text        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active', 'inactive', 'blocked')),
  credit_status            text        NOT NULL DEFAULT 'unrated'
                                       CHECK (credit_status IN ('unrated', 'green', 'yellow', 'red')),
  -- Communication language; NULL = tenant_settings.default_locale (three-level language).
  language                 text        CHECK (language ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_by               uuid,
  CONSTRAINT customers_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_entity_once UNIQUE (tenant_id, legal_entity_id),
  CONSTRAINT customers_owner FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT customers_name_key_pair
    CHECK ((display_name_enc IS NULL) = (display_name_key_version IS NULL)),
  -- Natural person → encrypted name only; company → plaintext name only.
  CONSTRAINT customers_name_protection
    CHECK (CASE WHEN is_natural_person
                THEN display_name IS NULL AND display_name_enc IS NOT NULL
                ELSE display_name IS NOT NULL AND display_name_enc IS NULL END)
);
CREATE UNIQUE INDEX customers_external_id ON customers (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX customers_owner_idx ON customers (tenant_id, owner_user_id);

-- ============================================================================================
-- customer_contacts — people at a customer; every personal field encrypted (P1)
-- ============================================================================================

CREATE TABLE customer_contacts (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL REFERENCES tenants (id),
  customer_id             uuid        NOT NULL,
  name_enc                bytea       NOT NULL,
  name_key_version        integer     NOT NULL CHECK (name_key_version >= 1),
  email_enc               bytea,
  email_key_version       integer     CHECK (email_key_version >= 1),
  email_bidx              bytea       CHECK (octet_length(email_bidx) = 32),
  email_bidx_key_version  integer     CHECK (email_bidx_key_version >= 1),
  phone_enc               bytea,
  phone_key_version       integer     CHECK (phone_key_version >= 1),
  is_primary              boolean     NOT NULL DEFAULT false,
  -- NULL = customers.language → tenant default.
  language                text        CHECK (language ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  status                  text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_by              uuid,
  CONSTRAINT customer_contacts_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT customer_contacts_customer
    FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  CONSTRAINT customer_contacts_email_pair
    CHECK ((email_enc IS NULL) = (email_key_version IS NULL)
           AND (email_enc IS NULL) = (email_bidx IS NULL)
           AND (email_bidx IS NULL) = (email_bidx_key_version IS NULL)),
  CONSTRAINT customer_contacts_phone_pair
    CHECK ((phone_enc IS NULL) = (phone_key_version IS NULL))
);
CREATE INDEX customer_contacts_email_bidx ON customer_contacts (tenant_id, email_bidx)
  WHERE email_bidx IS NOT NULL;
CREATE UNIQUE INDEX customer_contacts_single_primary ON customer_contacts (tenant_id, customer_id)
  WHERE is_primary;

-- ============================================================================================
-- user_roles.scope — resource scope of a role assignment (ADR 0002, decision 1)
-- ============================================================================================

-- Narrowest scope by default. Single-resource access exists only via access_grants (0.2c),
-- and only for external parties.
ALTER TABLE user_roles ADD COLUMN scope text NOT NULL DEFAULT 'OWN'
  CHECK (scope IN ('OWN', 'TEAM', 'ORGANIZATION'));

-- ============================================================================================
-- find_or_create_legal_entity — the ONLY write path to legal_entities for the app
-- ============================================================================================

-- Exact match on (country_code, tax_id) — never a list, never LIKE/fuzzy, never other columns.
-- Returns the id whether the entity existed or was created, so the caller cannot learn whether
-- the entity is known to the platform (rule 33). Existing rows are never modified: a caller's
-- legal_name does not overwrite the canonical one. Visibility still comes only from a link
-- (tenant_companies / customers) in the caller's own tenant.
-- search_path = '' — every object is schema-qualified (SECURITY DEFINER hygiene).
CREATE FUNCTION find_or_create_legal_entity(
  p_country_code         text,
  p_tax_id               text,
  p_legal_name           text,
  p_timezone             text,
  p_registration_number  text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF public.app_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'find_or_create_legal_entity requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$'
     OR p_tax_id IS NULL OR p_tax_id = '' OR p_tax_id <> pg_catalog.btrim(p_tax_id)
     OR p_legal_name IS NULL OR pg_catalog.btrim(p_legal_name) = ''
     OR p_timezone IS NULL OR p_timezone = '' THEN
    RAISE EXCEPTION 'find_or_create_legal_entity: invalid arguments'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.legal_entities
    (country_code, tax_id, registration_number, legal_name, normalized_name, timezone)
  VALUES
    (p_country_code, p_tax_id, nullif(pg_catalog.btrim(p_registration_number), ''),
     pg_catalog.btrim(p_legal_name),
     pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(p_legal_name), '\s+', ' ', 'g')),
     p_timezone)
  ON CONFLICT (country_code, tax_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT le.id INTO STRICT v_id
    FROM public.legal_entities le
    WHERE le.country_code = p_country_code AND le.tax_id = p_tax_id;
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION find_or_create_legal_entity(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_or_create_legal_entity(text, text, text, text, text) TO vigor_app;

-- ============================================================================================
-- updated_at triggers
-- ============================================================================================

CREATE TRIGGER subject_keys_updated_at BEFORE UPDATE ON subject_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER customer_contacts_updated_at BEFORE UPDATE ON customer_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================================
-- Row Level Security — ENABLE + FORCE on every table (owner included)
-- ============================================================================================

ALTER TABLE subject_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subject_keys
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_contacts
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- legal_entities: visible through the tenant's own companies OR its customers (rules 30, 33).
ALTER POLICY app_read_linked ON legal_entities
  USING (
    EXISTS (
      SELECT 1 FROM tenant_companies tc
      WHERE tc.legal_entity_id = legal_entities.id AND tc.tenant_id = app_tenant_id()
    )
    OR EXISTS (
      SELECT 1 FROM customers cu
      WHERE cu.legal_entity_id = legal_entities.id AND cu.tenant_id = app_tenant_id()
    )
  );

-- ============================================================================================
-- Grants for vigor_app
-- ============================================================================================

-- Keys are created and read; retiring/destroying a key is the rotation/erasure job (later task).
REVOKE UPDATE, DELETE, TRUNCATE ON subject_keys FROM vigor_app;
-- Customers and contacts are deactivated via status, never deleted (erasure = crypto-shredding).
REVOKE DELETE, TRUNCATE ON customers, customer_contacts FROM vigor_app;

-- ============================================================================================
-- PII registry (rule 20)
-- ============================================================================================

-- users.email / display_name stay plaintext: Better Auth (task 1.3) keeps the same values in
-- schema `auth` for login/MFA, so encrypting the copy here would add no protection (ADR 0003).
UPDATE pii_field_registry SET exception_reason = 'auth identity'
WHERE table_name = 'users' AND column_name IN ('email', 'display_name');
-- Snapshot/payload containers: audit() and the outbox write only ids, P0 values or ciphertext of
-- registered fields — never plaintext P1+ (ADR 0003).
UPDATE pii_field_registry SET exception_reason = 'container: ids, P0 values or ciphertext only'
WHERE (table_name, column_name) IN (('audit_log', 'before'), ('audit_log', 'after'),
                                    ('domain_events', 'payload'));
UPDATE pii_field_registry SET exception_reason = 'worker diagnostics: error codes only, never values'
WHERE table_name = 'domain_events' AND column_name = 'last_error';

INSERT INTO pii_field_registry
  (table_name, column_name, pii_class, conditional_on, conditional_pii_class, encrypted, exception_reason, purpose)
VALUES
  ('customers', 'display_name', 'P0', 'customers.is_natural_person = true', 'P1', false, NULL,
   'company name; NULL for a natural person (CHECK customers_name_protection)'),
  ('customers', 'display_name_enc', 'P1', NULL, NULL, true, NULL, 'natural person name'),
  ('customers', 'external_id', 'P0', NULL, NULL, false, NULL, 'id of the customer in the tenant source system'),
  ('customer_contacts', 'name_enc', 'P1', NULL, NULL, true, NULL, 'contact person name'),
  ('customer_contacts', 'email_enc', 'P1', NULL, NULL, true, NULL, 'contact e-mail for collection communication'),
  ('customer_contacts', 'email_bidx', 'P1', NULL, NULL, false,
   'keyed HMAC blind index per tenant (pseudonymised, not reversible)', 'exact e-mail lookup within the tenant'),
  ('customer_contacts', 'phone_enc', 'P1', NULL, NULL, true, NULL, 'contact phone for collection communication'),
  ('subject_keys', 'wrapped_key', 'P0', NULL, NULL, false, NULL, 'data key wrapped by the master key (not personal data)');

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 002)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('subject_keys', 'customers', 'customer_contacts')
       OR (c.table_name, c.column_name) IN (('user_roles', 'scope'),
                                            ('pii_field_registry', 'exception_reason')))
ON CONFLICT (table_name, column_name) DO NOTHING;
