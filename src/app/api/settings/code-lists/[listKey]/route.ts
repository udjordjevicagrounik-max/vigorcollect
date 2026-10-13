import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { codeUpsertSchema, EDITABLE_LISTS, upsertCode } from '@/server/settings/configuration';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ listKey: z.enum(EDITABLE_LISTS) });

// Adds / renames / reorders / deactivates a code (5.2). A code is never deleted (inactive).
export const PUT = withTenant<{ listKey: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await upsertCode(ctx, parsed.data.listKey, codeUpsertSchema.parse(await request.json())),
  );
});
