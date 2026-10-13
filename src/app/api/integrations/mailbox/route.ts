import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { getMasterKeyring } from '@/server/crypto/keyring';
import { getMailbox, mailboxFormSchema, saveMailboxForm } from '@/server/integrations/mailbox';

export const dynamic = 'force-dynamic';

// Mailbox connection of the tenant (5.3) — never a secret in the answer ("password set: yes").
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('integration.read');
  return NextResponse.json(await getMailbox(ctx));
});

// The IMAP/SMTP form; secrets sealed at once (integration key of the tenant).
export const PUT = withTenant(async (request, ctx) => {
  await ctx.requirePermission('integration.manage');
  return NextResponse.json(
    await saveMailboxForm(ctx, mailboxFormSchema.parse(await request.json()), getMasterKeyring()),
  );
});
