import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { newPaymentSchema, recordPayment } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

// A payment marked by a person: allocated to the named invoice, then FIFO by due date; pending
// promises it covers become fulfilled.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('payment.create');
  const input = newPaymentSchema.parse(await request.json());
  return NextResponse.json(await recordPayment(ctx, input), { status: 201 });
});
