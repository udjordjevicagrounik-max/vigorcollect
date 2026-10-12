import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createWorkflow, listWorkflows, workflowInputSchema } from '@/server/workflows/service';

export const dynamic = 'force-dynamic';

// Admin → Rules (task 3.1): list and create (a new rule starts as a draft version 1).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('settings.read');
  return NextResponse.json({ workflows: await listWorkflows(ctx) });
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  const input = workflowInputSchema.parse(await request.json());
  return NextResponse.json(await createWorkflow(ctx, input), { status: 201 });
});
