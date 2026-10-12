import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { customerListQuery, listReceivableCustomers } from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

// Customers visible to the member (scope OWN / TEAM / ORGANIZATION — scopeFilter()), with
// exposure, overdue and oldest overdue (task 2.3). Query: q, overdue=1, owner=me|none, status.
export const GET = withTenant(async (request, ctx) => {
  await ctx.requirePermission('customer.read');
  const query = customerListQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  return NextResponse.json({ customers: await listReceivableCustomers(ctx, query) });
});
