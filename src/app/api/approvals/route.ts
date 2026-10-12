import { NextResponse } from 'next/server';
import { grantChangeSchema, proposeGrantChange } from '@/server/approvals/service';
import { withTenant } from '@/server/auth/with-tenant';

export const dynamic = 'force-dynamic';

// Propose a change of the tenant's role matrix (maker, approval.create). Takes effect only after
// another person with role.manage approves (rule 11).
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('approval.create');
  const input = grantChangeSchema.parse(await request.json());
  return NextResponse.json(await proposeGrantChange(ctx, input), { status: 202 });
});
