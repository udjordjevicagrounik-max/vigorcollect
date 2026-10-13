import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { deleteSavedReport } from '@/server/reports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Deletes one of the member's own saved reports (a shared one only by its owner).
export const DELETE = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('report.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await deleteSavedReport(ctx, parsed.data.id));
});
