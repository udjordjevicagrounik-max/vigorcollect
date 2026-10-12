import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';

/**
 * Daily retention. What may be deleted is decided by the database, not by this code: the
 * worker's DELETE policies allow only mail_outbox rows older than 7 days and processed
 * domain_events older than 90 days (migration 007). Expired Better Auth sessions and
 * verification tokens and old API rate-limit windows are removed as vigor_app (no tenant data).
 */
export type RetentionCounts = {
  mailOutbox: number;
  domainEvents: number;
  authSessions: number;
  authVerifications: number;
  rateLimitWindows: number;
};

export async function runRetention(deps: {
  workerPool: Pool;
  appPool: Pool;
}): Promise<RetentionCounts> {
  const mail = await deps.workerPool.query(
    `DELETE FROM mail_outbox WHERE created_at < now() - interval '7 days'`,
  );
  const events = await deps.workerPool.query(
    `DELETE FROM domain_events
     WHERE status = 'processed' AND processed_at < now() - interval '90 days'`,
  );
  const sessions = await deps.appPool.query(`DELETE FROM auth."session" WHERE "expiresAt" < now()`);
  const verifications = await deps.appPool.query(
    `DELETE FROM auth."verification" WHERE "expiresAt" < now()`,
  );
  // Per-IP API windows (migration 008) are 60 s; anything older than an hour is noise.
  const windows = await deps.appPool.query(
    `DELETE FROM api_rate_limit WHERE window_start < now() - interval '1 hour'`,
  );
  const counts = {
    mailOutbox: mail.rowCount ?? 0,
    domainEvents: events.rowCount ?? 0,
    authSessions: sessions.rowCount ?? 0,
    authVerifications: verifications.rowCount ?? 0,
    rateLimitWindows: windows.rowCount ?? 0,
  };
  logEvent('retention.completed', counts);
  return counts;
}
