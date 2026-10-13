import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listColumnsSchema, saveListColumns } from '@/server/custom-fields/service';

export const dynamic = 'force-dynamic';

// The member's custom columns of the customer / invoice list (6.1).
export const PUT = withTenant(async (request, ctx) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read']);
  return NextResponse.json(
    await saveListColumns(ctx, listColumnsSchema.parse(await request.json())),
  );
});
