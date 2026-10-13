import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NotFoundError, type TenantContext } from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { readRendition } from '@/server/documents/service';

/**
 * exportService (rule 12): the ONLY way a file leaves the app. A download is a short-lived
 * signed link bound to tenant + member + document (HMAC, key derived from the master keyring,
 * info "export_links"); the download itself writes export_log (who, what, format, purpose,
 * sha256). A document leaves only as its PDF rendition (3.3, rendered in the worker); the HTML
 * is the in-app preview and never downloads (export_log has no html format, by decision).
 */

export const LINK_TTL_SECONDS = 300;

export const linkSchema = z.object({
  purpose: z.enum(['customer_correspondence', 'internal_review', 'legal']),
});
export const downloadQuery = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,200}\.\d{10}\.[a-z_]{3,40}$/),
});

function linkKey(keyring: MasterKeyring): Buffer {
  return Buffer.from(hkdfSync('sha256', keyring.current.key, 'platform', 'export_links', 32));
}

function sign(keyring: MasterKeyring, parts: string[]): string {
  return createHmac('sha256', linkKey(keyring)).update(parts.join('|')).digest('base64url');
}

export async function createDocumentLink(
  ctx: TenantContext,
  documentId: string,
  input: z.input<typeof linkSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
  now: Date = new Date(),
): Promise<{ url: string; expiresAt: string }> {
  const { purpose } = linkSchema.parse(input);
  // In scope, and the PDF exists (409 not_ready while the worker renders it).
  await readRendition(ctx, documentId, keyring);
  const expires = Math.floor(now.getTime() / 1000) + LINK_TTL_SECONDS;
  const mac = sign(keyring, [ctx.tenantId, ctx.userId, documentId, String(expires), purpose]);
  return {
    url: `/api/documents/${documentId}/download?token=${mac}.${expires}.${purpose}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

/** Verifies the link, writes export_log, returns the file. Another member's or tenant's link: 404. */
export async function downloadDocument(
  ctx: TenantContext,
  documentId: string,
  token: string,
  keyring: MasterKeyring = getMasterKeyring(),
  now: Date = new Date(),
): Promise<{ content: Buffer; format: string; filename: string }> {
  const [mac = '', expiresRaw = '', purpose = ''] = token.split('.');
  const expires = Number.parseInt(expiresRaw, 10);
  const expected = sign(keyring, [ctx.tenantId, ctx.userId, documentId, expiresRaw, purpose]);
  const ok =
    mac.length === expected.length &&
    timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) &&
    linkSchema.safeParse({ purpose }).success;
  if (!ok || expires < Math.floor(now.getTime() / 1000)) throw new NotFoundError();
  const doc = await readRendition(ctx, documentId, keyring);
  await ctx.db.query(
    `INSERT INTO export_log (tenant_id, actor_type, actor_id, export_type, format, purpose, row_count, filters,
                             file_sha256, request_id, created_by)
     VALUES (app_tenant_id(), 'user', $1, $2, $3, $4, 1, jsonb_build_object('document_id', $5::uuid), $6, $7, $1)`,
    [
      ctx.userId,
      `document.${doc.kind}`,
      doc.format,
      purpose,
      documentId,
      doc.checksum,
      ctx.requestId,
    ],
  );
  await ctx.audit({
    action: 'document.exported',
    entityType: 'documents',
    entityId: documentId,
    after: { purpose, format: doc.format },
  });
  return {
    content: doc.content,
    format: doc.format,
    filename: `${doc.kind}-${documentId.slice(0, 8)}.${doc.format}`,
  };
}
