-- 001_identity_tenant_governance_down.sql — reverts 001_identity_tenant_governance_up.sql.
-- Drops exactly what the up migration created, in reverse dependency order. No CASCADE:
-- if something outside 001 depends on these objects, the rollback must fail loudly.
-- Development/test databases only (go-live rule 15: additive migrations).

DROP TABLE domain_events;
DROP TABLE audit_log;
DROP FUNCTION audit_log_block_mutation();

-- The legal_entities read policy references tenant_companies; drop it before that table.
DROP POLICY app_read_linked ON legal_entities;

DROP TABLE feature_flags;
DROP FUNCTION feature_flags_require_platform();
DROP TABLE user_roles;
DROP TABLE role_permissions;
DROP TABLE roles;
DROP TABLE users;
DROP TABLE tenant_companies;
DROP TABLE tenant_settings;
DROP TABLE tenants;

DROP TABLE legal_entities;
DROP TABLE platform_feature_flags;
DROP TABLE permissions;
DROP TABLE pii_field_registry;
DROP TABLE exchange_rates;
DROP TABLE jurisdiction_profiles;

DROP FUNCTION set_updated_at();
DROP FUNCTION app_tenant_id();

DROP EXTENSION citext;
