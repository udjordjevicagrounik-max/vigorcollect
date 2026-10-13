import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { updateIntegration, updateIntegrationSchema } from '@/server/integrations/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Enable / disable, outbound URL and subscribed events (4.1).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('integration.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = updateIntegrationSchema.parse(await request.json());
  return NextResponse.json(await updateIntegration(ctx, parsed.data.id, input));
});
