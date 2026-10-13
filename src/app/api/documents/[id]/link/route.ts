import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { createDocumentLink, linkSchema } from '@/server/exports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// exportService (rule 12): a signed, 5-minute download link for this member only.
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('document.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = linkSchema.parse(await request.json());
  return NextResponse.json(await createDocumentLink(ctx, parsed.data.id, input));
});
