-- 003_sharing_governance_down.sql — reverts 003_sharing_governance_up.sql.
-- Reverse dependency order, no CASCADE. Development/test databases only (rule 15).
-- Fails loudly if consumers (customers without legal_entity_id) exist — remove them first.

DELETE FROM pii_field_registry
WHERE table_name IN ('code_lists', 'translations', 'external_parties', 'access_grants',
                     'data_sources', 'approval_requests', 'decisions', 'export_log')
   OR (table_name, column_name) IN (('customers', 'segment_list_key'));
UPDATE pii_field_registry SET exception_reason = NULL
WHERE (table_name = 'legal_entities' AND conditional_pii_class IS NOT NULL)
   OR (table_name = 'tenant_companies' AND column_name = 'display_name')
   OR (table_name = 'customers' AND column_name = 'display_name');

DROP TABLE export_log;
DROP TABLE decisions;
DROP FUNCTION decisions_guard();
DROP TABLE approval_requests;
DROP FUNCTION approval_requests_guard();
DROP TABLE data_sources;
DROP TABLE access_grants;
DROP FUNCTION access_grants_guard();
DROP TABLE external_parties;
DROP TABLE translations;

ALTER TABLE customers DROP CONSTRAINT customers_segment;
ALTER TABLE customers DROP COLUMN segment_list_key;
DROP TABLE code_lists;

ALTER TABLE customers DROP CONSTRAINT customers_identity_required;
ALTER TABLE customers ALTER COLUMN legal_entity_id SET NOT NULL;

DROP FUNCTION block_mutation();
