import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { saveTemplateVersion, templateVersionSchema } from '@/server/templates/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// A changed text is a new template version (whitelisted variables and tags only).
export const PUT = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('settings.manage');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = templateVersionSchema.parse(await request.json());
  return NextResponse.json(await saveTemplateVersion(ctx, parsed.data.id, input));
});
