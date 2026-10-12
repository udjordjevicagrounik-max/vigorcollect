import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { getImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Report of one run: counts, row errors (codes), reconciliation exceptions, processing state.
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('import.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getImport(ctx, parsed.data.id));
});
