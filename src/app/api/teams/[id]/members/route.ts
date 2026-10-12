import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { addTeamMember, memberSchema } from '@/server/teams/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('user.update');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  await addTeamMember(ctx, parsed.data.id, memberSchema.parse(await request.json()));
  return NextResponse.json({ ok: true });
});
