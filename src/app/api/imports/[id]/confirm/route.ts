import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { confirmImport } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Confirmation → domain event import.confirmed → the worker applies the run.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('import.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await confirmImport(ctx, parsed.data.id));
});
