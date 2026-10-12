import type { Pool } from 'pg';

/**
 * Tenant memberships of an authenticated person (ADR 0004). Before a tenant is chosen there is
 * no app.tenant_id, so FORCE RLS hides public.users. Migration 005 adds a read-only policy keyed
 * on app.auth_user_id: the app sees ONLY the membership rows of the person whose id Better Auth
 * just verified — never another person's, never a tenant's data. The policy applies only while
 * app.tenant_id is unset, so this transaction never sets it.
 *
 * Callers pass an auth user id that came from a verified Better Auth session or sign-in, never
 * from request input.
 */

export type Membership = { tenantId: string; userId: string; tenantName: string };

export async function activeMemberships(pool: Pool, authUserId: string): Promise<Membership[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.auth_user_id', $1, true)", [authUserId]);
    const { rows } = await client.query<Membership>(
      `SELECT u.tenant_id AS "tenantId", u.id AS "userId", t.display_name AS "tenantName"
       FROM public.users u
       JOIN public.tenants t ON t.id = u.tenant_id
       WHERE u.auth_user_id = $1::uuid AND u.status = 'active'
       ORDER BY t.display_name, u.tenant_id`,
      [authUserId],
    );
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function isMember(pool: Pool, authUserId: string, tenantId: string): Promise<boolean> {
  return (await activeMemberships(pool, authUserId)).some((m) => m.tenantId === tenantId);
}
