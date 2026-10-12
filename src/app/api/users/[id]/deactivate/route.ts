import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { deactivateMember } from '@/server/users/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Deactivation = status 'disabled' (never DELETE); access ends on the person's next request.
export const POST = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('user.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  await deactivateMember(ctx, parsed.data.id);
  return NextResponse.json({ ok: true });
});
