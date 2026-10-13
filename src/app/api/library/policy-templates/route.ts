import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/server/auth/with-tenant';
import { applyPolicyTemplate, POLICY_TEMPLATES } from '@/server/library/policy-templates';

export const dynamic = 'force-dynamic';

// Applies a policy template as rule DRAFTS (publishing stays maker-checker) — 6.4.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  const { template } = z.object({ template: z.enum(POLICY_TEMPLATES) }).parse(await request.json());
  return NextResponse.json(await applyPolicyTemplate(ctx, template), { status: 201 });
});
