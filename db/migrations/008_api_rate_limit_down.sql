-- 008_api_rate_limit_down.sql — reverts 008_api_rate_limit_up.sql (dev/test only, rule 15).

DELETE FROM pii_field_registry WHERE table_name = 'api_rate_limit';
DROP FUNCTION api_rate_limit_hit(text, integer, integer);
DROP TABLE api_rate_limit;
