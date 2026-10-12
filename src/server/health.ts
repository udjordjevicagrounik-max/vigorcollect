import { Pool } from 'pg';
import { jobHealth, type JobHealth } from '@/server/jobs/health';

/**
 * /health (rule 94): liveness + readiness facts, no personal or tenant data. 200 while the
 * database answers (jobs are reported, not fatal — the worker is its own process); 503 when the
 * database does not. Values only: counts, ages, a timestamp.
 */
export type HealthReport = {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  jobs: JobHealth | null;
};

export type HealthDeps = {
  pingDb(): Promise<void>;
  jobs(): Promise<JobHealth>;
};

export async function healthReport(deps: HealthDeps): Promise<HealthReport> {
  try {
    await deps.pingDb();
  } catch {
    return { status: 'degraded', db: 'down', jobs: null };
  }
  const jobs = await deps.jobs().catch(() => null);
  return { status: 'ok', db: 'ok', jobs };
}

let pool: Pool | undefined;

/** vigor_app pool with short timeouts: /health must answer fast even when the DB does not. */
function healthPool(): Pool {
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2_000,
    options: '-c statement_timeout=2000',
  });
  return pool;
}

export const liveHealthDeps: HealthDeps = {
  async pingDb() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    await healthPool().query('SELECT 1');
  },
  jobs: () => jobHealth(healthPool()),
};
