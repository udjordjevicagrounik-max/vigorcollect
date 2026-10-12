import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listCustomers } from '@/server/customers/service';

export const dynamic = 'force-dynamic';

// Customers visible to the member (scope OWN / TEAM / ORGANIZATION — scopeFilter()).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json({ customers: await listCustomers(ctx) });
});
