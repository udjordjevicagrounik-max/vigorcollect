import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listAttention } from '@/server/attention/service';

export const dynamic = 'force-dynamic';

// "Needs attention" (task 3.2): one list across customers, approvals, tasks, notifications,
// failed rule runs and import exceptions — each item carries its action.
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json({ items: await listAttention(ctx) });
});
