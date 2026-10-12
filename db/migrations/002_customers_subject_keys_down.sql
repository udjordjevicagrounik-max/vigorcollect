-- 002_customers_subject_keys_down.sql — reverts 002_customers_subject_keys_up.sql.
-- Reverse dependency order, no CASCADE. Development/test databases only (rule 15).

DELETE FROM pii_field_registry
WHERE table_name IN ('subject_keys', 'customers', 'customer_contacts')
   OR (table_name, column_name) IN (('user_roles', 'scope'), ('pii_field_registry', 'exception_reason'));

-- The legal_entities read policy references customers; restore the 001 definition first.
ALTER POLICY app_read_linked ON legal_entities
  USING (EXISTS (
    SELECT 1 FROM tenant_companies tc
    WHERE tc.legal_entity_id = legal_entities.id AND tc.tenant_id = app_tenant_id()
  ));

DROP FUNCTION find_or_create_legal_entity(text, text, text, text, text);

ALTER TABLE user_roles DROP COLUMN scope;

DROP TABLE customer_contacts;
DROP TABLE customers;
DROP TABLE subject_keys;

ALTER TABLE pii_field_registry DROP COLUMN exception_reason;
