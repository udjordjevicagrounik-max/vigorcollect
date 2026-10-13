import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { leadSchema, setTeamLead } from '@/server/teams/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Team lead (a member or nobody); audit + domain event team.lead_changed. Review S-06: naming a
// lead waits for a second administrator (202) unless the tenant has only one.
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('team.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const result = await setTeamLead(ctx, parsed.data.id, leadSchema.parse(await request.json()));
  return NextResponse.json(result, { status: result.status === 'applied' ? 200 : 202 });
});
