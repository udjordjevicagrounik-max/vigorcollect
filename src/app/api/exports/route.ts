import { NextResponse } from 'next/server';
import { withTenant } from '@/server/auth/with-tenant';
import { exportRequestSchema, listExportFiles, requestExport } from '@/server/exports/tables';

export const dynamic = 'force-dynamic';

// The member's prepared export files (5.2).
export const GET = withTenant(async (_request, ctx) => {
  await ctx.requirePermission('export.read');
  return NextResponse.json(await listExportFiles(ctx));
});

// exportService (rule 12): up to 5,000 rows the file itself (export_log written), above → 202
// with the export id (the worker prepares it). Filters travel in the body, never in the URL.
export const POST = withTenant(async (request, ctx) => {
  await ctx.requireAnyPermission(['customer.export', 'invoice.export', 'report.export']);
  const out = await requestExport(ctx, exportRequestSchema.parse(await request.json()));
  if (out.kind === 'queued') return NextResponse.json({ id: out.id }, { status: 202 });
  return new NextResponse(new Uint8Array(out.content), {
    headers: {
      'content-type': out.mime,
      'content-disposition': `attachment; filename="${out.filename}"`,
      'x-export-rows': String(out.rows),
      'cache-control': 'no-store',
    },
  });
});
