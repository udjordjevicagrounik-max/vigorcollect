import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { CF_ENTITIES, getValues, setValues, valuesSchema } from '@/server/custom-fields/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ entity: z.enum(CF_ENTITIES), id: z.uuid() });

// Custom field values of one customer / contact / invoice / case (6.1) — scope of its customer.
export const GET = withTenant<{ entity: string; id: string }>(async (_request, ctx, params) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read', 'case.read']);
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(await getValues(ctx, parsed.data.entity, parsed.data.id));
});

export const PATCH = withTenant<{ entity: string; id: string }>(async (request, ctx, params) => {
  await ctx.requireAnyPermission(['customer.update', 'invoice.update', 'case.update']);
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json(
    await setValues(
      ctx,
      parsed.data.entity,
      parsed.data.id,
      valuesSchema.parse(await request.json()),
    ),
  );
});
