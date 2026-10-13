-- 018_integrations_down.sql — reverts 018_integrations_up.sql (dev/test only, rule 15). Deletes
-- every integration, credential, webhook event, delivery and API key. Audit rows written by API
-- keys cannot be removed (INSERT-only), so the old actor_type CHECK comes back NOT VALID.

DELETE FROM pii_field_registry
WHERE table_name IN ('integrations', 'integration_credentials', 'external_records', 'sync_runs',
                     'webhook_events', 'outbound_deliveries', 'api_keys');

DROP TABLE IF EXISTS api_keys;
DROP FUNCTION IF EXISTS app_api_key_hash();
DROP TABLE IF EXISTS outbound_deliveries;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS external_records;
DROP TABLE IF EXISTS integration_credentials;
DROP TABLE IF EXISTS integrations;
DROP FUNCTION IF EXISTS app_inbound_integration_id();

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN ('user', 'system', 'job', 'ai')) NOT VALID;
