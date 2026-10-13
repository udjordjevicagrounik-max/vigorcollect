import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import {
  deleteReportDefinition,
  getReportDefinition,
  reportSaveSchema,
  saveReportDefinition,
} from '@/server/reporting/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('report.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getReportDefinition(ctx, parsed.data.id));
});

// Only the owner changes or deletes their report; a system report is copied instead.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('report.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await saveReportDefinition(ctx, reportSaveSchema.parse(await request.json()), parsed.data.id),
  );
});

export const DELETE = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('report.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await deleteReportDefinition(ctx, parsed.data.id));
});
