import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { draftSchema, getWorkflow, saveDraft } from '@/server/workflows/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// A rule with its versions and recent runs (explained).
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('settings.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getWorkflow(ctx, parsed.data.id));
});

// Saves the draft (a published version is never edited — a new draft version is started).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = draftSchema.parse(await request.json());
  return NextResponse.json(await saveDraft(ctx, parsed.data.id, input));
});
