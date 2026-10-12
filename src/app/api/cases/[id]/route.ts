import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { caseUpdateSchema, getCase, updateCase } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Case with its invoices and timeline (domain events + activities).
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('case.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getCase(ctx, parsed.data.id));
});

// Stage (never 'legal' — that needs an approved handover), priority, owner (case.assign), close.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('case.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = caseUpdateSchema.parse(await request.json());
  return NextResponse.json(await updateCase(ctx, parsed.data.id, input));
});
