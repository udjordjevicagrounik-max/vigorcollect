import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { definitionUpdateSchema, updateDefinition } from '@/server/custom-fields/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Label, required / filterable / list flags, position, archive / restore, new options (6.1).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await updateDefinition(ctx, parsed.data.id, definitionUpdateSchema.parse(await request.json())),
  );
});
