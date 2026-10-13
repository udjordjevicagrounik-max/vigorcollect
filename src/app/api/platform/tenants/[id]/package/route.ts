import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthBaseURL } from '@/server/auth/better-auth';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { createPackage } from '@/server/platform/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// A new data-package link for a client tenant (72 h); the link is shown once.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('platform.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await createPackage(ctx, parsed.data.id, getAuthBaseURL()), {
    status: 201,
  });
});
