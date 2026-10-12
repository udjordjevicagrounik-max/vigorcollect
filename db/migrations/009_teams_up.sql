-- 009_teams_up.sql — Sprint 1, task 1.6: teams, team members, customer ownership by team.
-- TEAM scope stops being OWN (ADR 0002, decision 1). Applied by scripts/migrate.sh as
-- vigor_migrate in one transaction. Protected file (rule 13).

CREATE TABLE teams (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id),
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{1,62}$'),
  name          text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  lead_user_id  uuid,
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  CONSTRAINT teams_tenant_key UNIQUE (tenant_id, id),
  CONSTRAINT teams_key_per_tenant UNIQUE (tenant_id, key),
  CONSTRAINT teams_lead FOREIGN KEY (tenant_id, lead_user_id) REFERENCES users (tenant_id, id)
);

-- Membership kind: only 'primary' exists in the MVP, and a person has at most ONE primary team
-- (partial unique index). Extending later is additive: ALTER TYPE … ADD VALUE 'secondary' —
-- the index keeps covering primary memberships only.
CREATE TYPE team_membership_kind AS ENUM ('primary');

CREATE TABLE team_members (
  id          uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid                 NOT NULL REFERENCES tenants (id),
  team_id     uuid                 NOT NULL,
  user_id     uuid                 NOT NULL,
  kind        team_membership_kind NOT NULL DEFAULT 'primary',
  created_at  timestamptz          NOT NULL DEFAULT now(),
  updated_at  timestamptz          NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT team_members_team FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id),
  CONSTRAINT team_members_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT team_members_unique UNIQUE (tenant_id, team_id, user_id)
);
CREATE UNIQUE INDEX team_members_one_primary_team ON team_members (tenant_id, user_id)
  WHERE kind = 'primary';
CREATE INDEX team_members_team ON team_members (tenant_id, team_id);

-- A customer may be owned by a team (TEAM scope) in addition to / instead of a user.
ALTER TABLE customers ADD COLUMN owner_team_id uuid;
ALTER TABLE customers ADD CONSTRAINT customers_owner_team
  FOREIGN KEY (tenant_id, owner_team_id) REFERENCES teams (tenant_id, id);
CREATE INDEX customers_owner_team_idx ON customers (tenant_id, owner_team_id);

CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER team_members_updated_at BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON team_members
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- Teams are archived, never deleted; membership rows may be removed (moving a person).
REVOKE DELETE, TRUNCATE ON teams FROM vigor_app;
REVOKE TRUNCATE ON team_members FROM vigor_app;

INSERT INTO pii_field_registry (table_name, column_name, pii_class, purpose)
SELECT c.table_name, c.column_name, 'P0', 'not personal data (registered by 009)'
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name IN ('teams', 'team_members')
       OR (c.table_name, c.column_name) IN (('customers', 'owner_team_id')))
ON CONFLICT (table_name, column_name) DO NOTHING;
