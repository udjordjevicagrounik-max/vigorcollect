import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { generateDocument, generateSchema, listDocuments } from '@/server/documents/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// Documents of a customer (task 3.2): list (document.read), generate a dunning letter or a
// statement of open items from the tenant's templates (document.create).
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('document.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  return NextResponse.json({ documents: await listDocuments(ctx, parsed.data.id) });
});

export const POST = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('document.create');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const input = generateSchema.parse(await request.json());
  return NextResponse.json(await generateDocument(ctx, parsed.data.id, input), { status: 201 });
});
