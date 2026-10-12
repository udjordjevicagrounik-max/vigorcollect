import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import type { AuthMailer } from '@/server/auth/better-auth';
import { activeMemberships } from '@/server/auth/memberships';
import type { MasterKeyring } from '@/server/crypto/keyring';
import { sendMail, type MailOptions } from './adapter';

/**
 * Better Auth's outgoing mail (password reset) through the mail adapter. A person is global
 * (schema auth) but mail_outbox is a tenant table: the mail is recorded under one of the person's
 * active memberships — a demo membership first, so a person who is in a demo tenant never gets
 * real mail (rule 24). Without an active membership nothing is sent; Better Auth answers the
 * same either way (rule 27).
 */
export function createAuthMailer(deps: {
  /** vigor_app pool WITHOUT search_path=auth (writes public.mail_outbox). */
  pool: Pool;
  keyring: () => MasterKeyring;
  options?: MailOptions;
}): AuthMailer {
  return async (mail) => {
    const memberships = await activeMemberships(deps.pool, mail.authUserId);
    const target = memberships.find((m) => m.isDemo) ?? memberships[0];
    if (!target) {
      logEvent('mail.skipped', { kind: mail.kind, reason: 'no_active_membership' });
      return;
    }
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [target.tenantId]);
      const { rows } = await client.query<{ locale: string }>(
        'SELECT locale FROM users WHERE id = $1',
        [target.userId],
      );
      await sendMail(
        client,
        deps.keyring(),
        { kind: 'password_reset', to: mail.to, url: mail.url, locale: rows[0]?.locale ?? 'en' },
        deps.options,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
