import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { setLifecycle, lifecycleSchema } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Sandbox → trial (14 days), activate, suspend, contract signed.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('platform.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await setLifecycle(ctx, parsed.data.id, lifecycleSchema.parse(await request.json())),
  );
});
