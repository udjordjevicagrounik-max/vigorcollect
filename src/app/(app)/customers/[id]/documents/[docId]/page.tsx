import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ForbiddenState } from '@/components/admin/forbidden-state';
import { Screen } from '@/components/shell/screen';
import { PermissionDeniedError } from '@/server/auth/permissions';
import { NotFoundError, withTenantPage } from '@/server/auth/with-tenant';
import { readDocument } from '@/server/documents/service';
import { assertSafeMarkup, TemplateError } from '@/server/templates/render';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid(), docId: z.uuid() });

// In-app preview of a generated document (task 3.2). The stored page is decrypted, its body is
// checked AGAIN against the tag whitelist (no attributes, no scripts) before it is shown — the
// values in it were escaped at render time. Downloads go through exportService (rule 12).
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  let body: string | null = null;
  try {
    body = await withTenantPage(async (ctx) => {
      const doc = await readDocument(ctx, parsed.data.docId);
      if (doc.customerId !== parsed.data.id) throw new NotFoundError();
      const html = doc.content.toString('utf8');
      const inner = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
      try {
        assertSafeMarkup(inner);
        return inner;
      } catch (error) {
        if (error instanceof TemplateError) return null;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return <ForbiddenState />;
    throw error;
  }
  const t = await getTranslations('documents');
  return (
    <Screen mobileClass="mobile-compact">
      <p className="mb-2 text-sm">
        <Link
          href={`/customers/${parsed.data.id}?tab=documents`}
          className="text-brand-purple underline"
        >
          {t('back')}
        </Link>
      </p>
      <h1 className="sr-only">{t('previewTitle')}</h1>
      {body === null ? (
        <p className="text-status-danger-fg">{t('unsafe')}</p>
      ) : (
        <article
          className="document-preview overflow-x-auto rounded-lg border border-border bg-surface p-4 text-text [&_h1]:text-xl [&_h1]:font-semibold [&_p]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1 [&_th]:border [&_th]:border-border [&_th]:p-1 [&_ul]:list-disc [&_ul]:pl-6"
          data-document-preview
          // Whitelisted tags only, no attributes (checked above); values escaped at render.
          dangerouslySetInnerHTML={{ __html: body }}
        />
      )}
      <p className="mt-3 text-xs text-text-muted">{t('downloadLater')}</p>
    </Screen>
  );
}
