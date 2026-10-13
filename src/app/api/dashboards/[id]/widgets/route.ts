import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { addWidget, widgetSchema } from '@/server/dashboards/service';

export const dynamic = 'force-dynamic';

// "mine" = the member's own home dashboard (a personal copy of the system one if needed).
const paramsSchema = z.object({ id: z.union([z.uuid(), z.literal('mine')]) });

export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await addWidget(ctx, parsed.data.id, widgetSchema.parse(await request.json())),
    {
      status: 201,
    },
  );
});
