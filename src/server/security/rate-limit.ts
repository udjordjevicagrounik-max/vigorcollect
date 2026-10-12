import { Pool } from 'pg';
import { logEvent } from '@/lib/log';

/**
 * Generic per-IP API rate limit (task 1.4), counted in the database (api_rate_limit, migration
 * 008) so every app instance shares it. Better Auth limits /api/auth/* itself. If the database
 * cannot be asked, the request passes and the event is logged (availability over a limiter; the
 * login path has its own limits and lockout).
 */
export const API_LIMIT = { windowSeconds: 60, max: 120 } as const;

export type RateLimitResult = { allowed: boolean; retryAfter: number };
export type RateLimiter = (key: string) => Promise<RateLimitResult>;

let pool: Pool | undefined;

export const databaseRateLimiter: RateLimiter = async (key) => {
  if (!process.env.DATABASE_URL) return { allowed: true, retryAfter: 0 };
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 2_000,
    options: '-c statement_timeout=2000',
  });
  try {
    const { rows } = await pool.query<{ allowed: boolean; retry_after: number }>(
      'SELECT allowed, retry_after FROM api_rate_limit_hit($1, $2, $3)',
      [key, API_LIMIT.windowSeconds, API_LIMIT.max],
    );
    return { allowed: rows[0]?.allowed ?? true, retryAfter: rows[0]?.retry_after ?? 0 };
  } catch (error) {
    logEvent('rate_limit.unavailable', {
      level: 'error',
      name: error instanceof Error ? error.name : 'unknown',
    });
    return { allowed: true, retryAfter: 0 };
  }
};
