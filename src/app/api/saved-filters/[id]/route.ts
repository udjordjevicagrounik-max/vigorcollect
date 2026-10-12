import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { deleteSavedFilter } from '@/server/receivables/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Deletes one of the member's own saved filters (another member's id is 404).
export const DELETE = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await deleteSavedFilter(ctx, parsed.data.id));
});
