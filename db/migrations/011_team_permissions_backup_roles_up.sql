-- 011_team_permissions_backup_roles_up.sql — Sprint 1 close-out.
--   * permission catalog: team.read, team.manage (docs/permissions.md is the source; grants to
--     roles are tenant data → seed);
--   * vigor_backup / vigor_restore (scripts/create-service-roles.sh, superuser, BEFORE this
--     migration): CONNECT, and each may append ONLY its own kind of ops_runs row.
-- Applied by scripts/migrate.sh as vigor_migrate in one transaction. Protected file (rule 13).

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['vigor_backup', 'vigor_restore'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'role % is missing — run scripts/create-service-roles.sh first (docs/runbook.md)', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND rolsuper) THEN
      RAISE EXCEPTION 'role % must not be SUPERUSER', r;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
  END LOOP;
END $$;

INSERT INTO permissions (key) VALUES ('team.read'), ('team.manage') ON CONFLICT (key) DO NOTHING;

-- Both roles have BYPASSRLS (pg_dump / row counts through FORCE RLS), so a policy could NOT
-- restrict them — the trigger does: each role appends only its own kind of row.
GRANT INSERT ON ops_runs TO vigor_backup, vigor_restore;

CREATE FUNCTION ops_runs_kind_by_role() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF (current_user = 'vigor_backup' AND NEW.kind <> 'backup')
     OR (current_user = 'vigor_restore' AND NEW.kind <> 'restore_test') THEN
    RAISE EXCEPTION 'ops_runs: % may record only its own kind of run', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ops_runs_kind_by_role BEFORE INSERT ON ops_runs
  FOR EACH ROW EXECUTE FUNCTION ops_runs_kind_by_role();
