import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { setFlag, flagSchema } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// A feature flag of the tenant (rule 31: the platform flag must be on).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('platform.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await setFlag(ctx, parsed.data.id, flagSchema.parse(await request.json())),
  );
});
