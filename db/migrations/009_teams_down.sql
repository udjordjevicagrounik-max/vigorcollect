-- 009_teams_down.sql — reverts 009_teams_up.sql (dev/test only, rule 15).

DELETE FROM pii_field_registry
WHERE table_name IN ('teams', 'team_members')
   OR (table_name, column_name) IN (('customers', 'owner_team_id'));

DROP INDEX customers_owner_team_idx;
ALTER TABLE customers DROP CONSTRAINT customers_owner_team;
ALTER TABLE customers DROP COLUMN owner_team_id;
DROP TABLE team_members;
DROP TYPE team_membership_kind;
DROP TABLE teams;
