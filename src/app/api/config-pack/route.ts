import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { configPackSchema, exportConfigPack, importConfigPack } from '@/server/library/config-pack';

export const dynamic = 'force-dynamic';

// Config pack (6.4): configuration as JSON, never secrets or business data. GET = download.
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return new NextResponse(JSON.stringify(await exportConfigPack(ctx), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="config-pack-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'no-store',
    },
  });
});

// Adds what is missing; never overwrites; rules arrive as drafts; roles are not imported.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requirePermission('settings.manage');
  return NextResponse.json(
    await importConfigPack(ctx, configPackSchema.parse(await request.json())),
  );
});
