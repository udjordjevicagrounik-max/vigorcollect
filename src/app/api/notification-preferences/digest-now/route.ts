import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { sendDigestNow } from '@/server/notifications/digest';

export const dynamic = 'force-dynamic';

// "Send me my digest now" (5.4): the member's own "My day", to their own address (sink on demo).
export const POST = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json(await sendDigestNow(ctx), { status: 202 });
});
