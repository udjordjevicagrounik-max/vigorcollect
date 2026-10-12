-- 011_team_permissions_backup_roles_down.sql — reverts 011 (dev/test only, rule 15).
-- The roles stay (cluster-wide, created outside migrations). Catalog keys still granted in some
-- tenant cannot be seen here (role_permissions is tenant data under FORCE RLS) — such a key is
-- kept with a NOTICE, as in 004 (re-seed after `up`).

DROP TRIGGER ops_runs_kind_by_role ON ops_runs;
DROP FUNCTION ops_runs_kind_by_role();
REVOKE INSERT ON ops_runs FROM vigor_backup, vigor_restore;

DO $$
DECLARE
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['team.read', 'team.manage'] LOOP
    BEGIN
      DELETE FROM permissions WHERE key = k;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'permission % still granted in a tenant — kept', k;
    END;
  END LOOP;
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM vigor_backup, vigor_restore', current_database());
END $$;
