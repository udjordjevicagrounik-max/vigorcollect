import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { promiseUpdateSchema, updatePromise } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Change amount / date of a pending promise, or cancel it.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('promise.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = promiseUpdateSchema.parse(await request.json());
  return NextResponse.json(await updatePromise(ctx, parsed.data.id, input));
});
