import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { genericTemplateCsv } from '@/server/library/import-templates';

export const dynamic = 'force-dynamic';

// The generic invoice import template (6.4) — headers the wizard maps on its own.
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('import.read');
  return new NextResponse(genericTemplateCsv(), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="uvoz-faktura-sablon.csv"',
      'cache-control': 'no-store',
    },
  });
});
