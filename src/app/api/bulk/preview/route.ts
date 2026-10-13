import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { bulkRequestSchema, previewBulk } from '@/server/bulk/service';

export const dynamic = 'force-dynamic';

// Preview of a bulk action (5.1): how many selected items are in scope + the first 10. No write.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read']);
  return NextResponse.json(await previewBulk(ctx, bulkRequestSchema.parse(await request.json())));
});
