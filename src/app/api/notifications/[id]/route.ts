import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { markNotificationRead, notificationReadSchema } from '@/server/attention/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Marks one of my in-app notifications as read.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('customer.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  notificationReadSchema.parse(await request.json());
  return NextResponse.json(await markNotificationRead(ctx, parsed.data.id));
});
