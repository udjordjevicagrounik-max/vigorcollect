import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logEvent } from '@/lib/log';
import type { AuditEntry } from '@/server/auth/audit';
import { scopeFilter } from '@/server/auth/scope';
import { ConflictError, NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { currentTenantId, type Queryable } from '@/server/crypto/subject-keys';
import { emitEvent } from '@/server/events';
import { renderForCustomer } from '@/server/templates/service';
import { renderPdf, type PdfResult } from './pdf';
import { getDocument, putDocument } from './storage';

/**
 * Documents (task 3.2): dunning letter (opomena) and statement of open items (IOS) rendered
 * from the tenant's 'document' templates as HTML; the worker then renders the PDF of the same
 * HTML (3.3, event document.generated → renderDocumentPdf, table document_renditions).
 * Generating: `document.create`; listing and in-app preview: `document.read` — always within the
 * customer's scope. Leaving the app = exportService, PDF only (rule 12).
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
  /** The PDF rendition exists (3.3) — only then can it be downloaded. */
  hasPdf: boolean;
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
    has_pdf: boolean;
  }>(
    `SELECT d.id, d.kind, d.format, d.locale, d.version, d.created_at, u.display_name AS creator,
            EXISTS (SELECT 1 FROM document_renditions r WHERE r.document_id = d.id AND r.format = 'pdf') AS has_pdf
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
    hasPdf: r.has_pdf,
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

/** The PDF of a document, scoped like the document (exportService only). Not rendered yet: 409. */
export async function readRendition(
  ctx: TenantContext,
  documentId: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<StoredDocument> {
  const doc = await readDocument(ctx, documentId, keyring);
  const { rows } = await ctx.db.query<{
    id: string;
    checksum: Buffer;
    storage_ref: string;
    key_version: number;
  }>(
    `SELECT id, checksum, storage_ref, key_version FROM document_renditions
     WHERE document_id = $1 AND format = 'pdf'`,
    [documentId],
  );
  const r = rows[0];
  if (!r) throw new ConflictError('not_ready');
  const content = getDocument(keyring, ctx.tenantId, r.id, {
    storageRef: r.storage_ref,
    keyVersion: r.key_version,
  });
  if (!createHash('sha256').update(content).digest().equals(r.checksum))
    throw new Error('rendition checksum mismatch');
  return { ...doc, format: 'pdf', checksum: r.checksum, content };
}

export type RenderOutcome = 'rendered' | 'exists' | 'not_html' | 'missing';

/**
 * Worker job document.render_pdf (3.3): HTML document → PDF rendition, inside withTenantJob
 * (one tenant, RLS). Idempotent: one PDF per document (UNIQUE), a redelivered event finds it.
 * The log carries ids, size and timing only — never the content or the customer.
 */
export async function renderDocumentPdf(
  db: Queryable,
  audit: (entry: AuditEntry) => Promise<void>,
  keyring: MasterKeyring,
  documentId: string,
  render: (html: string, at: Date) => Promise<PdfResult> = renderPdf,
): Promise<RenderOutcome> {
  const tenantId = await currentTenantId(db);
  const { rows } = await db.query<{
    id: string;
    format: string;
    checksum: Buffer;
    storage_ref: string;
    key_version: number;
    created_at: Date;
    has_pdf: boolean;
  }>(
    `SELECT d.id, d.format, d.checksum, d.storage_ref, d.key_version, d.created_at,
            EXISTS (SELECT 1 FROM document_renditions r WHERE r.document_id = d.id AND r.format = 'pdf') AS has_pdf
     FROM documents d WHERE d.id = $1`,
    [documentId],
  );
  const d = rows[0];
  if (!d) return 'missing';
  if (d.format !== 'html') return 'not_html';
  if (d.has_pdf) return 'exists';
  const html = getDocument(keyring, tenantId, d.id, {
    storageRef: d.storage_ref,
    keyVersion: d.key_version,
  });
  if (!createHash('sha256').update(html).digest().equals(d.checksum))
    throw new Error('document checksum mismatch');
  const started = Date.now();
  const { pdf, renderer } = await render(html.toString('utf8'), d.created_at);
  const id = randomUUID();
  const stored = putDocument(keyring, tenantId, id, pdf);
  const checksum = createHash('sha256').update(pdf).digest();
  const ins = await db.query<{ id: string }>(
    `INSERT INTO document_renditions (id, tenant_id, document_id, format, checksum, size_bytes, storage_ref,
                                      key_version, renderer)
     VALUES ($1, app_tenant_id(), $2, 'pdf', $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, document_id, format) DO NOTHING RETURNING id`,
    [id, documentId, checksum, pdf.length, stored.storageRef, stored.keyVersion, renderer],
  );
  if (!ins.rows[0]) return 'exists';
  await emitEvent(db, {
    eventType: 'document.rendered',
    aggregateType: 'documents',
    aggregateId: documentId,
    payload: { format: 'pdf' },
  });
  await audit({
    action: 'document.rendered',
    entityType: 'documents',
    entityId: documentId,
    after: { format: 'pdf', renderer, size_bytes: pdf.length },
  });
  logEvent('document.render_pdf', {
    tenantId,
    documentId,
    bytes: pdf.length,
    ms: Date.now() - started,
    renderer,
  });
  return 'rendered';
}

/** Re-render request for a document without PDF (e.g. generated before 3.3). */
export async function requestPdf(ctx: TenantContext, documentId: string): Promise<{ ok: true }> {
  const doc = await readDocument(ctx, documentId);
  await emitEvent(ctx.db, {
    eventType: 'document.render_requested',
    aggregateType: 'documents',
    aggregateId: doc.id,
    payload: { customer_id: doc.customerId },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  await ctx.audit({
    action: 'document.render_requested',
    entityType: 'documents',
    entityId: doc.id,
  });
  return { ok: true };
}
