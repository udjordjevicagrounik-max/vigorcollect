-- 010_ops_down.sql — reverts 010_ops_up.sql (dev/test only, rule 15).

DELETE FROM pii_field_registry WHERE table_name = 'ops_runs';
DROP FUNCTION platform_timezone();
DROP TABLE ops_runs;
