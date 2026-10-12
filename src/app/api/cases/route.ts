import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createCase, newCaseSchema } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

// Opens a collection case for a customer with the chosen open invoices (task 2.4).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('case.create');
  const input = newCaseSchema.parse(await request.json());
  return NextResponse.json(await createCase(ctx, input), { status: 201 });
});
