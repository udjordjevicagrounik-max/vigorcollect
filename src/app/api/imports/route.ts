import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { listImports, uploadImport, uploadSchema } from '@/server/imports/service';

export const dynamic = 'force-dynamic';

// Import runs (task 2.2): history and upload (file as base64 JSON — no multipart, rule 1.4).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('import.read');
  return NextResponse.json({ runs: await listImports(ctx) });
});

export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('import.create');
  const input = uploadSchema.parse(await request.json());
  return NextResponse.json(await uploadImport(ctx, input), { status: 201 });
});
