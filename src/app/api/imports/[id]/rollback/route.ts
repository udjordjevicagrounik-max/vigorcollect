import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { rollbackImport } from '@/server/imports/process';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Reverts what the run created and nobody touched since; the rest becomes exceptions.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('import.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await rollbackImport(ctx, parsed.data.id));
});
