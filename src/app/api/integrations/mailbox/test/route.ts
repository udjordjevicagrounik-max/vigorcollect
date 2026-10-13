import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { requestMailboxTest } from '@/server/integrations/mailbox';

export const dynamic = 'force-dynamic';

// "Check connection" (5.3): the worker probes IMAP + SMTP, then connects n8n → 202.
export const POST = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('integration.manage');
  return NextResponse.json(await requestMailboxTest(ctx), { status: 202 });
});
