import type { Pool } from 'pg';

export type JobHealth = {
  pending: number | null;
  failed: number | null;
  oldestPendingSeconds: number | null;
  lastRetentionAt: string | null;
};

/** Aggregates only, through job_health() (migration 007) — never job payloads. */
export async function jobHealth(pool: Pool): Promise<JobHealth> {
  const { rows } = await pool.query<{
    pending: number | null;
    failed: number | null;
    oldest_pending_seconds: number | null;
    last_retention_at: Date | null;
  }>('SELECT * FROM job_health()');
  const r = rows[0];
  return {
    pending: r?.pending ?? null,
    failed: r?.failed ?? null,
    oldestPendingSeconds: r?.oldest_pending_seconds ?? null,
    lastRetentionAt: r?.last_retention_at ? r.last_retention_at.toISOString() : null,
  };
}
