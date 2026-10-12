import type { Scope } from './permissions';

/**
 * scopeFilter() — THE one place that turns a grant's scope into a row predicate (task 1.6).
 * Every query over a scoped entity (customers today; invoices and cases later) appends it to
 * its WHERE clause; tests/golden/scope-usage.test.ts fails any query over such a table without
 * it. RLS already confines the query to the tenant; the scope narrows it inside the tenant.
 *
 *   OWN          → owner_user_id = me
 *   TEAM         → owned by me, OR owner_team_id ∈ my teams, OR owner_user_id ∈ members of my
 *                  teams
 *   ORGANIZATION → the whole tenant (no predicate)
 *
 * A row without any owner is visible only with ORGANIZATION. Values are bound parameters; only
 * the column names below (fixed, never input) enter the SQL text.
 */

const ENTITIES = {
  customers: { ownerUser: 'owner_user_id', ownerTeam: 'owner_team_id' },
} as const;

export type ScopedEntity = keyof typeof ENTITIES;

export type ScopePredicate = { sql: string; params: unknown[] };

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * @param alias      table alias used in the caller's FROM (e.g. 'c')
 * @param nextParam  the next free $n in the caller's query
 */
export function scopeFilter(
  entity: ScopedEntity,
  viewer: { userId: string; scope: Scope },
  alias: string,
  nextParam: number,
): ScopePredicate {
  if (!ALIAS.test(alias)) throw new Error('scopeFilter: invalid alias');
  const { ownerUser, ownerTeam } = ENTITIES[entity];
  const me = `$${nextParam}::uuid`;
  switch (viewer.scope) {
    case 'ORGANIZATION':
      return { sql: 'TRUE', params: [] };
    case 'OWN':
      return { sql: `(${alias}.${ownerUser} = ${me})`, params: [viewer.userId] };
    case 'TEAM':
      return {
        sql: `(${alias}.${ownerUser} = ${me}
          OR ${alias}.${ownerTeam} IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${me})
          OR ${alias}.${ownerUser} IN (
            SELECT mate.user_id FROM team_members mine
            JOIN team_members mate ON mate.team_id = mine.team_id
            WHERE mine.user_id = ${me}))`,
        params: [viewer.userId],
      };
  }
}
