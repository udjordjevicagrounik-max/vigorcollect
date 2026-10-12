import type { Pool, PoolClient } from 'pg';
import { writeAudit, type AuditEntry } from '@/server/auth/audit';

/**
 * Job equivalent of withTenant() (rule 2): every piece of tenant work in the worker runs as
 * vigor_app in ONE transaction with SET LOCAL app.tenant_id = the tenant of the event / schedule.
 * The tenant comes from the domain_events row or from tenant_clock() — never from job input that
 * a user could shape. Pre-tenant GUCs are reset. A handler never queries across tenants.
 */
export type TenantJobContext = {
  db: PoolClient;
  tenantId: string;
  jobId: string;
  audit(entry: AuditEntry): Promise<void>;
};

export async function withTenantJob<T>(
  appPool: Pool,
  tenantId: string,
  jobId: string,
  fn: (ctx: TenantJobContext) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('RESET app.auth_user_id');
    await client.query('RESET app.invite_token_hash');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn({
      db: client,
      tenantId,
      jobId,
      audit: (entry) => writeAudit(client, { type: 'job', id: null }, entry, null),
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
