import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { calendarSchema, saveCalendar } from '@/server/settings/configuration';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ companyId: z.uuid() });

// Working days and holidays of one company (rule 26).
export const PUT = withTenant<{ companyId: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await saveCalendar(ctx, parsed.data.companyId, calendarSchema.parse(await request.json())),
  );
});
