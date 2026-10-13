import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { downloadExportFile } from '@/server/exports/tables';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

// A prepared export file (5.2): only its requester, only while not expired; writes export_log.
export const GET = withTenant<{ id: string }>(async (_request, ctx, params) => {
  await ctx.requirePermission('export.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const file = await downloadExportFile(ctx, parsed.data.id);
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      'content-type': file.mime,
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
    },
  });
});
