import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/server/auth/with-tenant';
import {
  CF_ENTITIES,
  createDefinition,
  definitionCreateSchema,
  listDefinitions,
} from '@/server/custom-fields/service';

export const dynamic = 'force-dynamic';

const query = z.object({
  entity: z.enum(CF_ENTITIES).optional(),
  archived: z.enum(['1']).optional(),
  locale: z.enum(['sr-Latn', 'en']).optional(),
});

// Custom field definitions (6.1): GET for every member (forms, filters), POST for settings.manage.
export const GET = withTenant(async (request: NextRequest, ctx) => {
  await ctx.requireAnyPermission(['customer.read', 'invoice.read', 'case.read', 'settings.read']);
  const q = query.parse(Object.fromEntries(request.nextUrl.searchParams));
  return NextResponse.json(
    await listDefinitions(ctx, {
      entityType: q.entity,
      includeArchived: q.archived === '1',
      locale: q.locale,
    }),
  );
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return NextResponse.json(
    await createDefinition(ctx, definitionCreateSchema.parse(await request.json())),
    {
      status: 201,
    },
  );
});
