import { Pool, type PoolClient } from 'pg';

// Connections to the golden-test database ONLY (collect_test). Never the dev database.
function requireEnv(name: 'TEST_DATABASE_URL' | 'TEST_MIGRATE_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run the DB tests via "npm run test:db".`);
  if (!/_test(\?|$)/.test(value)) throw new Error(`${name} must point at a *_test database.`);
  return value;
}

/** vigor_app — the application role, subject to RLS. */
export const appPool = new Pool({ connectionString: requireEnv('TEST_DATABASE_URL'), max: 4 });
/** vigor_migrate — owner of the tables; FORCE RLS applies to it as well. */
export const migratePool = new Pool({
  connectionString: requireEnv('TEST_MIGRATE_DATABASE_URL'),
  max: 2,
});

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), migratePool.end()]);
}

/**
 * Runs `fn` in a transaction with SET LOCAL app.tenant_id (null = no tenant context) and
 * ROLLS BACK afterwards — tests never leave rows behind.
 */
export async function inTenant<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Same as inTenant but COMMITs — only for idempotent fixtures. */
export async function inTenantCommit(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Resolves to the Postgres SQLSTATE of the rejection, or 'OK' if the promise resolved. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}
