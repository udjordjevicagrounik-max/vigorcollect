import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { messageSchema, sendMessage } from '@/server/mail/communication';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Customer 360 → Communication (4.2): a reply / message from a template or free text.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('activity.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = messageSchema.parse(await request.json());
  return NextResponse.json(await sendMessage(ctx, parsed.data.id, input), { status: 201 });
});
