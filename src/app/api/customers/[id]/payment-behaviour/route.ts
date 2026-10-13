import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { paymentBehaviourSchema, setPaymentBehaviour } from '@/server/disputes/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// The collector's assessment of a customer: unwilling / unable / disputed (or none) — 5.1.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('customer.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = paymentBehaviourSchema.parse(await request.json());
  return NextResponse.json(await setPaymentBehaviour(ctx, parsed.data.id, input));
});
