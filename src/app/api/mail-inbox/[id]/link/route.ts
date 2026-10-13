import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { linkMessage, linkSchema } from '@/server/mail/communication';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Admin → Integrations → Unlinked messages (4.2): link to a customer or ignore.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('integration.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = linkSchema.parse(await request.json());
  return NextResponse.json(await linkMessage(ctx, parsed.data.id, input));
});
