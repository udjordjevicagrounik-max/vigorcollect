import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { createActivity, newActivitySchema } from '@/server/collections/service';

export const dynamic = 'force-dynamic';

// Call / email / note / meeting with outcome and next action; the note is stored encrypted.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('activity.create');
  const input = newActivitySchema.parse(await request.json());
  return NextResponse.json(await createActivity(ctx, input), { status: 201 });
});
