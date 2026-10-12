import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { validateImport, validateSchema } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Mapping → validation of every row → preview (first 50 rows + counts).
export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('import.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = validateSchema.parse(await request.json());
  return NextResponse.json(await validateImport(ctx, parsed.data.id, input));
});
