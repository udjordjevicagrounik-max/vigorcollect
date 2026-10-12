import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createPromise, newPromiseSchema } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

// New payment promise of a customer (optionally on a case).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('promise.create');
  const input = newPromiseSchema.parse(await request.json());
  return NextResponse.json(await createPromise(ctx, input), { status: 201 });
});
