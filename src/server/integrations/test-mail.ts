import { PermissionDeniedError } from '@/server/auth/permissions';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { sendTestMail, type Transport } from '@/server/mail/adapter';

/**
 * Admin → Integrations → "Send a test message" (session 5.1): a fixed message to the SIGNED-IN
 * member's own address, through the tenant's mailbox integration — queued in mail_outbox
 * (encrypted, dispatched by the worker to n8n) and audited. A demo tenant only ever reaches the
 * sink (rule 24, adapter + database trigger). An API key has no address → refused.
 */
export async function sendIntegrationTestMail(
  ctx: TenantContext,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ outboxId: string; transport: Transport }> {
  await ctx.requirePermission('integration.manage');
  if (ctx.actorType === 'api_key') throw new PermissionDeniedError();
  const { rows } = await ctx.db.query<{ email: string; locale: string; tenant: string }>(
    `SELECT u.email, u.locale, t.display_name AS tenant
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.status = 'active'`,
    [ctx.userId],
  );
  const me = rows[0];
  if (!me) throw new NotFoundError();
  const sent = await sendTestMail(ctx.db, keyring, {
    to: me.email,
    locale: me.locale,
    tenantName: me.tenant,
  });
  // audit() keeps P0 only: the outbox id and the way out, never the address.
  await ctx.audit({
    action: 'mail.test_queued',
    entityType: 'mail_outbox',
    entityId: sent.id,
    after: { kind: 'test', transport: sent.transport },
  });
  return { outboxId: sent.id, transport: sent.transport };
}
