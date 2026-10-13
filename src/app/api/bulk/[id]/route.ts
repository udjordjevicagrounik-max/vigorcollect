import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { getBulkReport } from '@/server/bulk/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Report of a bulk run (5.1): per item ok / failed / skipped.
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read']);
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getBulkReport(ctx, parsed.data.id));
});
