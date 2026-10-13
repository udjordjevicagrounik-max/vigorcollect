import { randomUUID, createHash } from 'node:crypto';
import { createTranslator } from 'next-intl';
import { z } from 'zod';
import en from '../../../messages/en.json' with { type: 'json' };
import sr from '../../../messages/sr-Latn.json' with { type: 'json' };
import { isLocale, type Locale } from '@/i18n/config';
import {
  ConflictError,
  createTenantContext,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import { getDocument, putDocument } from '@/server/documents/storage';
import { emitEvent } from '@/server/events';
import type { TenantJobContext } from '@/server/jobs/tenant-job';
import {
  customerListQuery,
  invoiceListQuery,
  listOpenInvoices,
  listReceivableCustomers,
} from '@/server/receivables/service';
import { REPORT_KEYS, reportConfig, runReport, type ReportKey } from '@/server/reports/service';
import { amount, date, int, MIME, text, toCsv, toXlsx, type Cell, type Table } from './tabular';

/**
 * Tabular exports (5.2) — part of exportService (rule 12): the only way a list or a report
 * leaves the app. Every export: the matching *.export permission, the member's scope (the same
 * reads as the screen), a row limit, export_log on the way out (who, what, filters, row count,
 * sha256). Up to SYNC_ROWS rows the file is returned at once; above, it is queued for the worker
 * (export_files, sealed in the documents storage) and downloaded later by the requester.
 * Formats: CSV always, XLSX from our own writer (tabular.ts) — amounts never pass through a float.
 */

export const SYNC_ROWS = 5000;
export const MAX_ROWS = 100_000;

const EXPORT_TYPES = [
  'customers',
  'invoices',
  ...REPORT_KEYS.map((k) => `report.${k}` as const),
] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const exportRequestSchema = z.object({
  type: z.enum(EXPORT_TYPES),
  format: z.enum(['csv', 'xlsx']).default('csv'),
  /** customers: customerListQuery; invoices: invoiceListQuery; report.*: reportConfig. */
  filters: z.record(z.string(), z.unknown()).default({}),
  purpose: z
    .enum(['internal_review', 'customer_correspondence', 'legal'])
    .default('internal_review'),
});
export type ExportRequest = z.input<typeof exportRequestSchema>;

const permissionFor = (type: ExportType) =>
  type === 'customers'
    ? 'customer.export'
    : type === 'invoices'
      ? 'invoice.export'
      : 'report.export';

const MESSAGES = { 'sr-Latn': sr, en } as const;

async function memberLocale(ctx: Pick<TenantContext, 'db' | 'userId'>): Promise<Locale> {
  const { rows } = await ctx.db.query<{ locale: string }>(
    'SELECT locale FROM users WHERE id = $1',
    [ctx.userId],
  );
  const l = rows[0]?.locale ?? 'en';
  return isLocale(l) ? l : 'en';
}

/** Builds the table the member may export; `limit` rows at most (+1 to detect "more"). */
async function buildTable(
  ctx: TenantContext,
  type: ExportType,
  filters: Record<string, unknown>,
  limit: number,
  ids?: string[],
): Promise<Table> {
  const locale = await memberLocale(ctx);
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'exports.columns' });
  if (type === 'customers') {
    const rows = await listReceivableCustomers(ctx, customerListQuery.parse(filters), limit, ids);
    return {
      columns: [
        t('customer'),
        t('taxId'),
        t('externalId'),
        t('status'),
        t('owner'),
        t('currency'),
        t('exposure'),
        t('overdue'),
        t('disputed'),
        t('oldestDays'),
        t('risk'),
        t('behaviour'),
      ],
      rows: rows.map((c): Cell[] => [
        text(c.displayName ?? t('naturalPerson')),
        text(c.taxId),
        text(c.externalId),
        text(c.status),
        text(c.ownerName),
        text(c.currency),
        amount(c.exposure),
        amount(c.overdue),
        amount(c.disputed),
        int(c.oldestDaysOverdue),
        text(c.riskBand),
        text(c.paymentBehaviour),
      ]),
    };
  }
  if (type === 'invoices') {
    const rows = await listOpenInvoices(ctx, invoiceListQuery.parse(filters), limit, ids);
    return {
      columns: [
        t('invoice'),
        t('customer'),
        t('issueDate'),
        t('dueDate'),
        t('currency'),
        t('total'),
        t('open'),
        t('daysOverdue'),
        t('bucket'),
        t('disputed'),
      ],
      rows: rows.map((i): Cell[] => [
        text(i.number),
        text(i.customerName ?? t('naturalPerson')),
        date(i.issueDate),
        date(i.dueDate),
        text(i.currency),
        amount(i.amountTotal),
        amount(i.amountOpen),
        int(i.daysOverdue),
        text(i.bucket),
        text(i.isDisputed ? t('yes') : t('no')),
      ]),
    };
  }
  const key = type.slice('report.'.length) as ReportKey;
  const r = await runReport(ctx, key, reportConfig.parse(filters), 'report.export');
  const tr = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'reports.columns' });
  return {
    columns: r.columns.map((c) =>
      c.label ? c.label : tr.has(c.key as 'customer') ? tr(c.key as 'customer') : c.key,
    ),
    rows: r.rows.slice(0, limit).map((row) =>
      r.columns.map((c): Cell => {
        const v = row[c.key] ?? null;
        if (c.type === 'amount') return amount(v === null ? null : String(v));
        if (c.type === 'int') return int(v === null ? null : Number(v));
        if (c.type === 'date') return date(v === null ? null : String(v));
        return text(v === null ? null : String(v));
      }),
    ),
  };
}

const render = (table: Table, format: 'csv' | 'xlsx', sheet: string) =>
  format === 'xlsx' ? toXlsx(table, sheet) : toCsv(table);

async function logExport(
  ctx: TenantContext,
  entry: {
    type: string;
    format: string;
    purpose: string;
    rows: number;
    filters: Record<string, unknown>;
    sha256: Buffer;
  },
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO export_log (tenant_id, actor_type, actor_id, export_type, format, purpose, row_count, filters,
                             file_sha256, request_id, created_by)
     VALUES (app_tenant_id(), 'user', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $1)`,
    [
      ctx.userId,
      entry.type,
      entry.format,
      entry.purpose,
      entry.rows,
      JSON.stringify(entry.filters),
      entry.sha256,
      ctx.requestId,
    ],
  );
}

export type ExportOutcome =
  | { kind: 'file'; content: Buffer; filename: string; mime: string; rows: number }
  | { kind: 'queued'; id: string };

/** Synchronous up to SYNC_ROWS rows; above that queued for the worker (202 + export id). */
export async function requestExport(
  ctx: TenantContext,
  input: ExportRequest,
  opts: { syncRows?: number } = {},
): Promise<ExportOutcome> {
  const req = exportRequestSchema.parse(input);
  const syncRows = opts.syncRows ?? SYNC_ROWS;
  await ctx.requirePermission(permissionFor(req.type));
  const table = await buildTable(ctx, req.type, req.filters, syncRows + 1);
  if (table.rows.length <= syncRows) {
    const content = render(table, req.format, req.type);
    await logExport(ctx, {
      type: `export.${req.type}`,
      format: req.format,
      purpose: req.purpose,
      rows: table.rows.length,
      filters: req.filters,
      sha256: createHash('sha256').update(content).digest(),
    });
    await ctx.audit({
      action: 'export.downloaded',
      entityType: 'export_log',
      entityId: ctx.requestId,
      after: { export_type: req.type, format: req.format, rows: table.rows.length },
    });
    return {
      kind: 'file',
      content,
      filename: `${req.type.replace('.', '-')}-${new Date().toISOString().slice(0, 10)}.${req.format}`,
      mime: MIME[req.format],
      rows: table.rows.length,
    };
  }
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO export_files (id, tenant_id, export_type, format, filters, requested_by, request_id)
     VALUES ($1, app_tenant_id(), $2, $3, $4::jsonb, $5, $6)`,
    [
      id,
      `export.${req.type}`,
      req.format,
      JSON.stringify({ ...req.filters, purpose: req.purpose }),
      ctx.userId,
      ctx.requestId,
    ],
  );
  await ctx.audit({
    action: 'export.queued',
    entityType: 'export_files',
    entityId: id,
    after: { export_type: req.type, format: req.format },
  });
  await emitEvent(ctx.db, {
    eventType: 'export.requested',
    aggregateType: 'export_files',
    aggregateId: id,
    payload: { export_type: req.type, format: req.format },
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { kind: 'queued', id };
}

async function store(
  ctx: Pick<TenantContext, 'db' | 'tenantId'>,
  keyring: MasterKeyring,
  id: string,
  content: Buffer,
  rows: number,
): Promise<void> {
  const stored = putDocument(keyring, ctx.tenantId, id, content);
  await ctx.db.query(
    `UPDATE export_files SET status = 'ready', row_count = $2, size_bytes = $3, file_sha256 = $4,
            storage_ref = $5, key_version = $6, finished_at = now() WHERE id = $1`,
    [
      id,
      rows,
      content.length,
      createHash('sha256').update(content).digest(),
      stored.storageRef,
      stored.keyVersion,
    ],
  );
}

/** Worker: export.requested — builds the file as the requester (scope + permission again). */
export async function runExportFile(
  job: TenantJobContext,
  id: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<'ready' | 'failed' | null> {
  const { rows } = await job.db.query<{
    export_type: string;
    format: 'csv' | 'xlsx';
    filters: Record<string, unknown>;
    status: string;
    requested_by: string;
    request_id: string | null;
  }>(
    `SELECT export_type, format, filters, status, requested_by, request_id FROM export_files
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const f = rows[0];
  if (!f || f.status === 'ready' || f.status === 'failed') return null;
  const ctx = createTenantContext(job.db, {
    tenantId: job.tenantId,
    userId: f.requested_by,
    authUserId: 'job:export',
    requestId: f.request_id ?? job.jobId,
  });
  const type = f.export_type.slice('export.'.length) as ExportType;
  const filters = Object.fromEntries(Object.entries(f.filters).filter(([k]) => k !== 'purpose'));
  try {
    await job.db.query('SAVEPOINT export_file');
    await ctx.requirePermission(permissionFor(type));
    const table = await buildTable(ctx, type, filters, MAX_ROWS + 1);
    if (table.rows.length > MAX_ROWS) throw new ConflictError('limit_exceeded');
    await store(ctx, keyring, id, render(table, f.format, type), table.rows.length);
    await job.db.query('RELEASE SAVEPOINT export_file');
    return 'ready';
  } catch (error) {
    await job.db.query('ROLLBACK TO SAVEPOINT export_file');
    const code = error instanceof ConflictError ? error.code : 'internal';
    await job.db.query(
      `UPDATE export_files SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1`,
      [id, code],
    );
    return 'failed';
  }
}

/** Bulk export (5.1 → 5.2): the selected rows into a ready export file; result_ref for the run. */
export async function exportSelection(
  ctx: TenantContext,
  run: { id: string; entity: 'customers' | 'invoices'; ids: string[] },
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ resultRef: string; rows: number }> {
  await ctx.requirePermission(permissionFor(run.entity));
  const table = await buildTable(ctx, run.entity, {}, run.ids.length, run.ids);
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO export_files (id, tenant_id, export_type, format, filters, requested_by, request_id, status)
     VALUES ($1, app_tenant_id(), $2, 'csv', jsonb_build_object('bulk_run_id', $3::uuid), $4, $5, 'running')`,
    [id, `export.${run.entity}`, run.id, ctx.userId, ctx.requestId],
  );
  await store(ctx, keyring, id, toCsv(table), table.rows.length);
  return { resultRef: `export:${id}`, rows: table.rows.length };
}

export type ExportFileView = {
  id: string;
  exportType: string;
  format: string;
  status: string;
  rowCount: number | null;
  errorCode: string | null;
  createdAt: string;
  expiresAt: string;
};

/** The member's own export files (newest first). */
export async function listExportFiles(ctx: TenantContext): Promise<ExportFileView[]> {
  await ctx.requirePermission('export.read');
  const { rows } = await ctx.db.query<{
    id: string;
    export_type: string;
    format: string;
    status: string;
    row_count: number | null;
    error_code: string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, export_type, format, status, row_count, error_code, created_at, expires_at
     FROM export_files WHERE requested_by = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 50`,
    [ctx.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    exportType: r.export_type,
    format: r.format,
    status: r.status,
    rowCount: r.row_count,
    errorCode: r.error_code,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
  }));
}

/** Download of a ready export file: requester only, not expired; writes export_log. */
export async function downloadExportFile(
  ctx: TenantContext,
  id: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<{ content: Buffer; filename: string; mime: string }> {
  const { rows } = await ctx.db.query<{
    export_type: string;
    format: 'csv' | 'xlsx';
    filters: Record<string, unknown>;
    row_count: number;
    storage_ref: string;
    key_version: number;
    file_sha256: Buffer;
  }>(
    `SELECT export_type, format, filters, row_count, storage_ref, key_version, file_sha256
     FROM export_files WHERE id = $1 AND requested_by = $2 AND status = 'ready' AND expires_at > now()`,
    [id, ctx.userId],
  );
  const f = rows[0];
  if (!f) throw new NotFoundError();
  const type = f.export_type.slice('export.'.length) as ExportType;
  await ctx.requirePermission(permissionFor(type));
  const content = getDocument(keyring, ctx.tenantId, id, {
    storageRef: f.storage_ref,
    keyVersion: f.key_version,
  });
  const purpose = typeof f.filters.purpose === 'string' ? f.filters.purpose : 'internal_review';
  await logExport(ctx, {
    type: f.export_type,
    format: f.format,
    purpose,
    rows: f.row_count,
    filters: { ...f.filters, export_file_id: id },
    sha256: f.file_sha256,
  });
  await ctx.audit({
    action: 'export.downloaded',
    entityType: 'export_files',
    entityId: id,
    after: { export_type: f.export_type, format: f.format, rows: f.row_count },
  });
  return {
    content,
    filename: `${type.replace('.', '-')}-${id.slice(0, 8)}.${f.format}`,
    mime: MIME[f.format],
  };
}
