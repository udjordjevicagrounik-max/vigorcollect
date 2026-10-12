import type { Queryable } from '@/server/crypto/subject-keys';

/**
 * requirePermission('object.action') — rule 7. Reads the CURRENT tenant's role_permissions
 * through the user's user_roles (RLS keeps it inside the tenant) and returns the widest scope
 * the user holds the permission with. TEAM behaves as OWN until teams exist (1.6).
 *
 * - key not in the platform catalog → UnknownPermissionError (a bug: 500 + error log);
 * - user does not hold it → PermissionDeniedError (403, no detail).
 *
 * Checker-only grants (🅼 in docs/permissions.md) are not distinguished here yet: the database
 * enforces maker ≠ checker on approval_requests / decisions (rule 11); the flow is 1.4.
 */

export type Scope = 'OWN' | 'TEAM' | 'ORGANIZATION';
export type PermissionGrant = { key: string; scope: Scope };

const SCOPE_RANK: Record<Scope, number> = { OWN: 1, TEAM: 2, ORGANIZATION: 3 };
const KEY_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
  constructor() {
    super('forbidden');
  }
}

export class UnknownPermissionError extends Error {
  override name = 'UnknownPermissionError';
  constructor(readonly key: string) {
    super('unknown permission key');
  }
}

export async function checkPermission(
  db: Queryable,
  userId: string,
  key: string,
): Promise<PermissionGrant> {
  if (!KEY_SHAPE.test(key)) throw new UnknownPermissionError(key);
  const { rows } = await db.query<{ known: boolean; scopes: Scope[] | null }>(
    `SELECT EXISTS (SELECT 1 FROM permissions WHERE key = $1) AS known,
            (SELECT array_agg(DISTINCT ur.scope)
             FROM user_roles ur
             JOIN role_permissions rp ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE ur.user_id = $2 AND p.key = $1) AS scopes`,
    [key, userId],
  );
  const row = rows[0];
  if (!row?.known) throw new UnknownPermissionError(key);
  const scopes = row.scopes ?? [];
  if (scopes.length === 0) throw new PermissionDeniedError();
  const scope = scopes.reduce((a, b) => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a));
  return { key, scope };
}

/** Every permission key the user holds in the current tenant (navigation, button visibility). */
export async function permissionKeys(db: Queryable, userId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT DISTINCT p.key
     FROM user_roles ur
     JOIN role_permissions rp ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.key));
}
