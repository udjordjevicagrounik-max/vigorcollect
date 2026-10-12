import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { taskUpdateSchema, updateTask } from '@/server/attention/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Closes one of my tasks (done / cancelled).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('activity.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = taskUpdateSchema.parse(await request.json());
  return NextResponse.json(await updateTask(ctx, parsed.data.id, input));
});
