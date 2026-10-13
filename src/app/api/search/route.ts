import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { globalSearch, searchQuery } from '@/server/search/service';

export const dynamic = 'force-dynamic';

// Global search (5.1): POST {q} — the query may be a name or an e-mail, so it never goes into a
// URL (access logs, history). At most 20 hits within the member's scope.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('customer.read');
  return NextResponse.json({
    hits: await globalSearch(ctx, searchQuery.parse(await request.json())),
  });
});
