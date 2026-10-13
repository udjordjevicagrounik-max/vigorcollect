import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { sendIntegrationTestMail } from '@/server/integrations/test-mail';

export const dynamic = 'force-dynamic';

// Admin → Integrations → "Send a test message" (session 5.1): to the signed-in member's own
// address through the tenant's mailbox integration; demo tenant = sink only (rule 24). Audited.
export const POST = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('integration.manage');
  return NextResponse.json(await sendIntegrationTestMail(ctx), { status: 202 });
});
