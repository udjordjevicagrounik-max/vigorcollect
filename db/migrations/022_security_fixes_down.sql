-- 022_security_fixes_down.sql — reverts 022_security_fixes_up.sql (dev/test only, rule 15).

-- S-03
DROP TRIGGER IF EXISTS session_active_tenant ON auth."session";
DROP FUNCTION IF EXISTS auth_session_active_tenant_guard();
ALTER POLICY app_all ON auth."user" USING (true) WITH CHECK (true);
ALTER POLICY app_all ON auth."session" USING (true) WITH CHECK (true);
ALTER POLICY app_all ON auth."account" USING (true) WITH CHECK (true);
ALTER POLICY app_all ON auth."verification" USING (true) WITH CHECK (true);
ALTER POLICY app_all ON auth."twoFactor" USING (true) WITH CHECK (true);
ALTER POLICY app_all ON auth."rateLimit" USING (true) WITH CHECK (true);

-- S-02
DELETE FROM pii_field_registry WHERE table_name = 'jurisdiction_profiles' AND column_name = 'party_id_rules';
ALTER TABLE jurisdiction_profiles DROP COLUMN IF EXISTS party_id_rules;
DELETE FROM reconciliation_exceptions WHERE kind = 'review_required';
ALTER TABLE reconciliation_exceptions DROP CONSTRAINT reconciliation_exceptions_kind_check;
ALTER TABLE reconciliation_exceptions ADD CONSTRAINT reconciliation_exceptions_kind_check
  CHECK (kind IN ('paid_invoice_changed', 'total_changed', 'open_amount_increased',
                  'currency_changed', 'customer_changed', 'rollback_blocked')) NOT VALID;

-- S-01: back to the 002 function body and the table-level SELECT.
CREATE OR REPLACE FUNCTION find_or_create_legal_entity(
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
DROP VIEW IF EXISTS legal_entities_public;
REVOKE SELECT (id, country_code, tax_id, registration_number, legal_name, normalized_name, timezone,
               address_line1, address_line2, postal_code, city, region, address_country_code)
  ON legal_entities FROM vigor_app;
GRANT SELECT ON legal_entities TO vigor_app;

-- S-06
DELETE FROM pii_field_registry WHERE table_name = 'api_keys' AND column_name IN ('scope', 'activated_at');
ALTER TABLE api_keys DROP COLUMN IF EXISTS activated_at, DROP COLUMN IF EXISTS scope;

-- S-09
DROP FUNCTION IF EXISTS mail_outbox_claim(uuid, timestamptz, timestamptz);

-- S-05: back to the 007 definition (DEFINER owned by vigor_migrate).
CREATE OR REPLACE FUNCTION job_health()
  RETURNS TABLE (pending integer, failed integer, oldest_pending_seconds integer,
                 last_retention_at timestamptz)
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY EXECUTE $q$
    SELECT count(*) FILTER (WHERE state IN ('created', 'retry'))::int,
           count(*) FILTER (WHERE state = 'failed')::int,
           extract(epoch FROM now() - min(created_on) FILTER (
             WHERE state IN ('created', 'retry') AND start_after <= now()))::int,
           max(completed_on) FILTER (WHERE name = 'retention' AND state = 'completed')
    FROM pgboss.job $q$;
EXCEPTION WHEN undefined_table OR insufficient_privilege OR invalid_schema_name THEN
  RETURN QUERY SELECT NULL::int, NULL::int, NULL::int, NULL::timestamptz;
END $$;
REVOKE ALL ON FUNCTION job_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_health() TO vigor_app, vigor_worker;

REVOKE USAGE ON SCHEMA pgboss FROM vigor_app;
