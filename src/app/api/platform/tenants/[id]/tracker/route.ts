import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { updateTracker, trackerUpdateSchema } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Implementation tracker step done / undone, lead (tenant #0 records).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('platform.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await updateTracker(ctx, parsed.data.id, trackerUpdateSchema.parse(await request.json())),
  );
});
