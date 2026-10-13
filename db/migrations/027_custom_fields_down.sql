-- 027_custom_fields_down.sql — reverts 027 (dev/test only, rule 15).
DELETE FROM pii_field_registry
WHERE table_name IN ('custom_field_definitions', 'custom_field_values', 'user_list_columns')
   OR (table_name = 'tenant_settings' AND column_name = 'custom_fields_max');
DELETE FROM translations WHERE entity_type = 'custom_field';
DELETE FROM code_lists WHERE list_key LIKE 'cf\_%';
DROP TABLE user_list_columns;
DROP TABLE custom_field_values;
DROP TABLE custom_field_definitions;
DROP FUNCTION custom_field_register_pii();
DROP FUNCTION custom_field_definitions_guard();
ALTER TABLE translations DROP CONSTRAINT translations_entity_type_check;
ALTER TABLE translations ADD CONSTRAINT translations_entity_type_check
  CHECK (entity_type IN ('role', 'code_list'));
ALTER TABLE tenant_settings DROP COLUMN custom_fields_max;
