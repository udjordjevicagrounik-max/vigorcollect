-- 030_platform_signup_down.sql — reverts 030 (dev/test only, rule 15).
DELETE FROM pii_field_registry
WHERE table_name IN ('implementation_trackers', 'onboarding_packages', 'signup_requests')
   OR (table_name = 'tenants' AND column_name IN ('lifecycle_status', 'trial_ends_at', 'contract_signed_at',
                                                  'sandbox_expires_at', 'trial_reminded_at'));
DROP FUNCTION platform_mark_data_received(uuid);
DROP FUNCTION onboarding_package_lookup(bytea);
DROP FUNCTION platform_purge_sandbox(uuid);
DROP FUNCTION platform_purgeable_sandboxes();
DROP FUNCTION platform_trials_to_remind();
DROP FUNCTION platform_tenant_flags(uuid);
DROP FUNCTION platform_set_flag(uuid, text, boolean, uuid);
DROP FUNCTION platform_set_lifecycle(uuid, text, integer, boolean);
DROP FUNCTION platform_create_tenant(text, text, char, text, text, char, text, text, integer, boolean, text, text);
DROP FUNCTION platform_tenants();
DROP FUNCTION platform_assert_operator();
DROP FUNCTION IF EXISTS platform_operator_id();
DROP POLICY platform_write ON tenants;
DELETE FROM feature_flags WHERE flag_key = 'signup.pipedrive_lead';
DELETE FROM platform_feature_flags WHERE key = 'signup.pipedrive_lead';

DELETE FROM import_runs WHERE status = 'staged';
ALTER TABLE import_runs DROP CONSTRAINT import_runs_payload_lifetime;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_payload_lifetime
  CHECK (payload_enc IS NULL OR status IN ('uploaded', 'validated', 'confirmed'));
ALTER TABLE import_runs DROP CONSTRAINT import_runs_status_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_status_check
  CHECK (status IN ('uploaded', 'validated', 'confirmed', 'completed', 'failed', 'cancelled', 'rolled_back'));

DROP TABLE onboarding_packages;
DROP TABLE signup_requests;
DROP TABLE implementation_trackers;

DO $$
DECLARE
  tid uuid;
BEGIN
  PERFORM set_config('app.tenant_clock', 'on', true);
  FOR tid IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE key = 'platform.manage');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.tenant_clock', '', true);
END $$;
DELETE FROM permissions WHERE key = 'platform.manage';

CREATE OR REPLACE FUNCTION mail_outbox_demo_sink_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.transport IS NOT DISTINCT FROM OLD.transport THEN
    RETURN NEW;
  END IF;
  IF NEW.transport <> 'sink' AND EXISTS (
    SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.is_demo
  ) THEN
    RAISE EXCEPTION 'mail_outbox: a demo tenant sends e-mail only to the sink (rule 24)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION tenant_writable(tenants);
ALTER TABLE tenants DROP CONSTRAINT tenants_lifecycle_dates;
ALTER TABLE tenants DROP COLUMN trial_reminded_at, DROP COLUMN sandbox_expires_at,
  DROP COLUMN contract_signed_at, DROP COLUMN trial_ends_at, DROP COLUMN lifecycle_status;
