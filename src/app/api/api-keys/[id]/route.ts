import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { revokeApiKey } from '@/server/integrations/api-keys';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Revoke (4.1): the key stops working at once; the row stays (history).
export const DELETE = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('integration.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await revokeApiKey(ctx, parsed.data.id));
});
