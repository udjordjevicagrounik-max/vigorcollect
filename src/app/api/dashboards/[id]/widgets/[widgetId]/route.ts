import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { removeWidget, updateWidget, widgetUpdateSchema } from '@/server/dashboards/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid(), widgetId: z.uuid() });

export const PUT = withTenant<{ id: string; widgetId: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await updateWidget(
      ctx,
      parsed.data.id,
      parsed.data.widgetId,
      widgetUpdateSchema.parse(await request.json()),
    ),
  );
});

export const DELETE = withTenant<{ id: string; widgetId: string }>(
  async (_request, ctx, params) => {
    await ctx.requirePermission('customer.read');
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) throw new NotFoundError();
    return NextResponse.json(await removeWidget(ctx, parsed.data.id, parsed.data.widgetId));
  },
);
