import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopeFilter } from '@/server/auth/scope';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { emitEvent } from '@/server/events';
import { renderForCustomer } from '@/server/templates/service';
import { getDocument, putDocument } from './storage';

/**
 * Documents (task 3.2): dunning letter (opomena) and statement of open items (IOS) rendered
 * from the tenant's 'document' templates. Format: HTML until a PDF renderer is approved
 * (NEXT.md). Generating: `document.create`; listing and in-app preview: `document.read` —
 * always within the customer's scope. Leaving the app = exportService (rule 12).
 */

export const generateSchema = z.object({
  kind: z.enum(['dunning_letter', 'statement']),
  caseId: z.uuid().optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/)
    .optional(),
});

export type DocumentRow = {
  id: string;
  kind: 'dunning_letter' | 'statement';
  format: 'html' | 'pdf';
  locale: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
};

async function scoped(ctx: TenantContext, customerId: string, permission: string): Promise<void> {
  const { scope } = await ctx.requirePermission(permission);
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.id = $1 AND ${filter.sql}`,
    [customerId, ...filter.params],
  );
  if (!rows.length) throw new NotFoundError();
}

/** A complete, self-contained HTML page (no scripts, no external resources). */
function page(title: string, body: string, locale: string): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:.25rem .5rem;text-align:left}</style>
</head><body>${body}</body></html>`;
}

export async function generateDocument(
  ctx: TenantContext,
  customerId: string,
  input: z.input<typeof generateSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ id: string; version: number }> {
  const data = generateSchema.parse(input);
  await scoped(ctx, customerId, 'document.create');
  const rendered = await renderForCustomer(
    ctx,
    {
      key: data.kind,
      channel: 'document',
      customerId,
      locale: data.locale,
      permission: 'document.create',
    },
    keyring,
  );
  const id = randomUUID();
  const html = Buffer.from(
    page(rendered.subject.replace(/[<>&"]/g, ''), rendered.html, rendered.locale),
    'utf8',
  );
  const stored = putDocument(keyring, ctx.tenantId, id, html);
  const next = await ctx.db.query<{ v: number }>(
    'SELECT coalesce(max(version), 0) + 1 AS v FROM documents WHERE customer_id = $1 AND kind = $2',
    [customerId, data.kind],
  );
  const version = next.rows[0]?.v ?? 1;
  await ctx.db.query(
    `INSERT INTO documents (id, tenant_id, customer_id, case_id, kind, template_id, format, locale, version, checksum,
                            size_bytes, storage_ref, key_version, created_by)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, 'html', $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      customerId,
      data.caseId ?? null,
      data.kind,
      rendered.templateId,
      rendered.locale,
      version,
      createHash('sha256').update(html).digest(),
      html.length,
      stored.storageRef,
      stored.keyVersion,
      ctx.userId,
    ],
  );
  await ctx.audit({
    action: 'document.generated',
    entityType: 'documents',
    entityId: id,
    after: { kind: data.kind, version, format: 'html', customer_id: customerId },
  });
  await emitEvent(ctx.db, {
    eventType: 'document.generated',
    aggregateType: 'documents',
    aggregateId: id,
    payload: { kind: data.kind, customer_id: customerId, case_id: data.caseId ?? null },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id, version };
}

export async function listDocuments(
  ctx: TenantContext,
  customerId: string,
): Promise<DocumentRow[]> {
  await scoped(ctx, customerId, 'document.read');
  const { rows } = await ctx.db.query<{
    id: string;
    kind: DocumentRow['kind'];
    format: DocumentRow['format'];
    locale: string;
    version: number;
    created_at: Date;
    creator: string | null;
  }>(
    `SELECT d.id, d.kind, d.format, d.locale, d.version, d.created_at, u.display_name AS creator
     FROM documents d LEFT JOIN users u ON u.id = d.created_by
     WHERE d.customer_id = $1 ORDER BY d.created_at DESC`,
    [customerId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    format: r.format,
    locale: r.locale,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    createdBy: r.creator,
  }));
}

export type StoredDocument = {
  id: string;
  customerId: string;
  kind: string;
  format: 'html' | 'pdf';
  checksum: Buffer;
  content: Buffer;
};

/** A document's content, for the in-app preview or exportService — scoped like its customer. */
export async function readDocument(
  ctx: TenantContext,
  documentId: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<StoredDocument> {
  const { scope } = await ctx.requirePermission('document.read');
  const filter = scopeFilter('customers', { userId: ctx.userId, scope }, 'c', 2);
  const { rows } = await ctx.db.query<{
    id: string;
    customer_id: string;
    kind: string;
    format: 'html' | 'pdf';
    checksum: Buffer;
    storage_ref: string;
    key_version: number;
  }>(
    `SELECT d.id, d.customer_id, d.kind, d.format, d.checksum, d.storage_ref, d.key_version
     FROM documents d JOIN customers c ON c.id = d.customer_id
     WHERE d.id = $1 AND ${filter.sql}`,
    [documentId, ...filter.params],
  );
  const d = rows[0];
  if (!d) throw new NotFoundError();
  const content = getDocument(keyring, ctx.tenantId, d.id, {
    storageRef: d.storage_ref,
    keyVersion: d.key_version,
  });
  if (!createHash('sha256').update(content).digest().equals(d.checksum))
    throw new Error('document checksum mismatch');
  return {
    id: d.id,
    customerId: d.customer_id,
    kind: d.kind,
    format: d.format,
    checksum: d.checksum,
    content,
  };
}
