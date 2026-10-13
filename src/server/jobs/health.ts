import type { Pool } from 'pg';

export type JobHealth = {
  pending: number | null;
  failed: number | null;
  oldestPendingSeconds: number | null;
  lastRetentionAt: string | null;
};

/**
 * Aggregates only, through job_health() (migration 022) — never job payloads. The call runs code
 * the worker installed (as vigor_worker), so it gets its own connection that is DESTROYED
 * afterwards: a session setting left behind there can never reach a request (review S-05).
 */
export async function jobHealth(pool: Pool): Promise<JobHealth> {
  const client = await pool.connect();
  const result = await client
    .query<{
      pending: number | null;
      failed: number | null;
      oldest_pending_seconds: number | null;
      last_retention_at: Date | null;
    }>('SELECT * FROM job_health()')
    .finally(() => client.release(true));
  const r = result.rows[0];
  return {
    pending: r?.pending ?? null,
    failed: r?.failed ?? null,
    oldestPendingSeconds: r?.oldest_pending_seconds ?? null,
    lastRetentionAt: r?.last_retention_at ? r.last_retention_at.toISOString() : null,
  };
}
