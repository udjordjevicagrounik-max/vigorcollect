import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { leadSchema, setTeamLead } from '@/server/teams/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Team lead (a member or nobody); audit + domain event team.lead_changed.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('team.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  await setTeamLead(ctx, parsed.data.id, leadSchema.parse(await request.json()));
  return NextResponse.json({ ok: true });
});
