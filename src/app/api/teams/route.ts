import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createTeam, newTeamSchema } from '@/server/teams/service';

export const dynamic = 'force-dynamic';

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('user.update');
  const input = newTeamSchema.parse(await request.json());
  return NextResponse.json(await createTeam(ctx, input), { status: 201 });
});
