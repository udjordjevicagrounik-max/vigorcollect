import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { cancelImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Abandons an unconfirmed run; the uploaded rows are dropped.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('import.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await cancelImport(ctx, parsed.data.id));
});
