import { z } from 'zod';
import { NotFoundError, withTenant } from '@/server/auth/with-tenant';
import { downloadDocument, downloadQuery } from '@/server/exports/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
const TYPES: Record<string, string> = { pdf: 'application/pdf' };

// The download of a signed link: verifies it, writes export_log, streams the file (rule 12).
export const GET = withTenant<{ id: string }>(async (request, ctx, params) => {
  await ctx.requirePermission('document.read');
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) throw new NotFoundError();
  const { token } = downloadQuery.parse(Object.fromEntries(request.nextUrl.searchParams));
  const file = await downloadDocument(ctx, parsed.data.id, token);
  return new Response(new Uint8Array(file.content), {
    headers: {
      'content-type': TYPES[file.format] ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
    },
  });
});
