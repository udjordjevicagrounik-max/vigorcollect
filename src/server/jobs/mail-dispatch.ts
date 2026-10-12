import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';

/**
 * Mail dispatcher. Sink rows are final when captured (CHECK mail_outbox_sink_status, 006) — the
 * sink IS their delivery. Real transports are queued as 'pending'; there is no SMTP sender yet
 * (nodemailer not approved, BACKLOG), so pending rows stay pending and visible.
 */
export type SmtpSender = (outboxId: string) => Promise<void>;

export async function dispatchMail(
  workerPool: Pool,
  smtp?: SmtpSender,
): Promise<{ pending: number; sent: number }> {
  const { rows } = await workerPool.query<{ id: string }>(
    `SELECT id FROM mail_outbox WHERE transport = 'smtp' AND status = 'pending'
     ORDER BY created_at LIMIT 100`,
  );
  if (!smtp) {
    if (rows.length) logEvent('mail.smtp_unavailable', { level: 'warn', pending: rows.length });
    return { pending: rows.length, sent: 0 };
  }
  let sent = 0;
  for (const r of rows) {
    await smtp(r.id);
    await workerPool.query(
      `UPDATE mail_outbox SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'pending'`,
      [r.id],
    );
    sent += 1;
  }
  return { pending: rows.length - sent, sent };
}
