import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getMasterKeyring, type MasterKeyring } from '@/server/crypto/keyring';
import type { Queryable } from '@/server/crypto/subject-keys';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  type TenantContext,
} from '@/server/auth/with-tenant';
import { emitEvent } from '@/server/events';
import { openGrid, sealGrid } from './crypto';
import { CsvError, parseCsv } from './csv';
import {
  detectColumns,
  detectDateOrder,
  detectDecimal,
  mappingSchema,
  missingRequired,
  validateRows,
  type ImportRow,
  type Mapping,
  type RowResult,
} from './rows';
import { readXlsx, XlsxError, type Grid } from './xlsx';

/**
 * Invoice import (task 2.2): upload → detection → mapping → validation → preview → confirm →
 * worker (event import.confirmed, src/server/imports/process.ts) → report; rollback of a run.
 * `import.read` to see runs, `import.create` for everything that changes them (rollback
 * included — the catalog has no separate key; NEXT.md).
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export const PREVIEW_ROWS = 50;
const MAX_ERRORS_SHOWN = 500;

export const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  format: z.enum(['csv', 'xlsx']),
  // base64 of the file; 5 MB of bytes ≈ 7 MB of text
  content: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4),
  sourceId: z.uuid().optional(),
  companyId: z.uuid().optional(),
});

export const validateSchema = z.object({ mapping: mappingSchema });

export type ImportUpload = {
  id: string;
  headers: string[];
  sample: string[][];
  rowsTotal: number;
  mapping: Mapping;
  templateUsed: boolean;
};

export type ImportPreview = {
  id: string;
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  errorsByCode: Record<string, number>;
  rows: (
    | { rowNumber: number; ok: true; value: ImportRow }
    | { rowNumber: number; ok: false; errors: { field: string; code: string }[] }
  )[];
};

export type ImportRunView = {
  id: string;
  status: string;
  fileFormat: string;
  sourceName: string;
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  invoicesCreated: number;
  invoicesUpdated: number;
  invoicesUnchanged: number;
  customersCreated: number;
  exceptionsCount: number;
  processing: 'pending' | 'processing' | 'failed' | 'done' | null;
  createdAt: string;
  completedAt: string | null;
  errors: { rowNumber: number; field: string; code: string }[];
  exceptions: {
    id: string;
    kind: string;
    rowNumber: number | null;
    invoiceId: string | null;
    currency: string | null;
    oldAmount: string | null;
    newAmount: string | null;
    status: string;
  }[];
};

function parseFile(format: 'csv' | 'xlsx', bytes: Buffer): Grid {
  try {
    if (format === 'xlsx') return readXlsx(bytes, MAX_ROWS);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseCsv(text, MAX_ROWS);
  } catch (error) {
    if (error instanceof XlsxError || error instanceof CsvError) {
      if (error.reason === 'too_large') throw new ConflictError('file_too_large');
      throw new ConflictError('file_unreadable');
    }
    if (error instanceof TypeError) throw new ConflictError('file_unreadable'); // not UTF-8
    throw error;
  }
}

async function defaults(ctx: TenantContext, companyId: string) {
  const { rows } = await ctx.db.query<{ currency: string; country: string }>(
    `SELECT ts.default_currency AS currency, ts.country_code AS country
     FROM tenant_settings ts, tenant_companies c WHERE c.id = $1`,
    [companyId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

export async function uploadImport(
  ctx: TenantContext,
  input: z.input<typeof uploadSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<ImportUpload> {
  await ctx.requirePermission('import.create');
  const data = uploadSchema.parse(input);
  const bytes = Buffer.from(data.content, 'base64');
  if (bytes.length > MAX_FILE_BYTES) throw new ConflictError('file_too_large');
  const grid = parseFile(data.format, bytes);
  if (grid.length < 2) throw new ConflictError('no_valid_rows');

  const source = await ctx.db.query<{ id: string }>(
    data.sourceId
      ? `SELECT id FROM data_sources WHERE id = $1 AND status = 'active'`
      : `SELECT id FROM data_sources WHERE name = 'file-import' AND status = 'active'`,
    data.sourceId ? [data.sourceId] : [],
  );
  const company = await ctx.db.query<{ id: string }>(
    data.companyId
      ? 'SELECT id FROM tenant_companies WHERE id = $1'
      : 'SELECT id FROM tenant_companies ORDER BY is_default DESC, created_at LIMIT 1',
    data.companyId ? [data.companyId] : [],
  );
  const sourceId = source.rows[0]?.id;
  const companyId = company.rows[0]?.id;
  if (!sourceId || !companyId) throw new NotFoundError();

  const header = grid[0] ?? [];
  const template = await ctx.db.query<{ mapping: Mapping }>(
    `SELECT mapping FROM import_mappings WHERE source_id = $1 AND kind = 'invoices'`,
    [sourceId],
  );
  const saved = mappingSchema.safeParse(template.rows[0]?.mapping);
  const usable = saved.success && Object.values(saved.data.columns).every((c) => c < header.length);
  const columns = usable ? saved.data.columns : detectColumns(header);
  const mapping: Mapping = usable
    ? saved.data
    : { columns, decimal: detectDecimal(grid, columns), dateOrder: detectDateOrder(grid, columns) };

  const id = crypto.randomUUID();
  const sealed = sealGrid(keyring, ctx.tenantId, id, grid);
  await ctx.db.query(
    `INSERT INTO import_runs (id, tenant_id, source_id, company_id, file_format, file_sha256,
                              payload_enc, payload_key_version, mapping, rows_total, created_by)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      sourceId,
      companyId,
      data.format,
      createHash('sha256').update(bytes).digest(),
      sealed.ciphertext,
      sealed.keyVersion,
      mapping,
      grid.length - 1,
      ctx.userId,
    ],
  );
  await ctx.audit({
    action: 'import.uploaded',
    entityType: 'import_runs',
    entityId: id,
    after: { format: data.format, rows_total: grid.length - 1, source_id: sourceId },
  });
  return {
    id,
    headers: header,
    sample: grid.slice(1, 6),
    rowsTotal: grid.length - 1,
    mapping,
    templateUsed: usable,
  };
}

type RunRow = {
  id: string;
  status: string;
  source_id: string;
  company_id: string;
  payload_enc: Buffer | null;
  payload_key_version: number | null;
  mapping: Mapping | null;
};

async function lockRun(ctx: TenantContext, runId: string): Promise<RunRow> {
  const { rows } = await ctx.db.query<RunRow>(
    `SELECT id, status, source_id, company_id, payload_enc, payload_key_version, mapping
     FROM import_runs WHERE id = $1 FOR UPDATE`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw new NotFoundError();
  return run;
}

export function runGrid(keyring: MasterKeyring, tenantId: string, run: RunRow): Grid {
  if (!run.payload_enc || run.payload_key_version === null) throw new ConflictError('conflict');
  return openGrid(keyring, tenantId, run.id, {
    ciphertext: run.payload_enc,
    keyVersion: run.payload_key_version,
  });
}

function summarize(results: RowResult[]) {
  const errorsByCode: Record<string, number> = {};
  for (const r of results) {
    if (!r.ok) for (const e of r.errors) errorsByCode[e.code] = (errorsByCode[e.code] ?? 0) + 1;
  }
  const valid = results.filter((r) => r.ok).length;
  return { valid, invalid: results.length - valid, errorsByCode };
}

export async function validateImport(
  ctx: TenantContext,
  runId: string,
  input: z.input<typeof validateSchema>,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<ImportPreview> {
  await ctx.requirePermission('import.create');
  const { mapping } = validateSchema.parse(input);
  if (missingRequired(mapping).length) throw new InvalidRequestError();
  const run = await lockRun(ctx, runId);
  if (!['uploaded', 'validated'].includes(run.status)) throw new ConflictError('conflict');
  const grid = runGrid(keyring, ctx.tenantId, run);
  const results = validateRows(grid, mapping, await defaults(ctx, run.company_id));
  const { valid, invalid, errorsByCode } = summarize(results);

  await ctx.db.query('DELETE FROM import_row_errors WHERE run_id = $1', [runId]);
  const errors = results.flatMap((r) =>
    r.ok ? [] : r.errors.map((e) => [r.rowNumber, e.field, e.code] as const),
  );
  if (errors.length) {
    await ctx.db.query(
      `INSERT INTO import_row_errors (tenant_id, run_id, row_number, field, error_code)
       SELECT app_tenant_id(), $1, e.row_number, e.field, e.code
       FROM unnest($2::int[], $3::text[], $4::text[]) AS e(row_number, field, code)`,
      [runId, errors.map((e) => e[0]), errors.map((e) => e[1]), errors.map((e) => e[2])],
    );
  }
  await ctx.db.query(
    `UPDATE import_runs SET status = 'validated', mapping = $2, rows_valid = $3, rows_invalid = $4,
            error_report = $5, updated_by = $6
     WHERE id = $1`,
    [runId, mapping, valid, invalid, { by_code: errorsByCode }, ctx.userId],
  );
  // The mapping becomes the template of this tenant + source.
  await ctx.db.query(
    `INSERT INTO import_mappings (tenant_id, source_id, kind, mapping, created_by, updated_by)
     VALUES (app_tenant_id(), $1, 'invoices', $2, $3, $3)
     ON CONFLICT (tenant_id, source_id, kind) DO UPDATE SET mapping = EXCLUDED.mapping, updated_by = EXCLUDED.updated_by`,
    [run.source_id, mapping, ctx.userId],
  );
  await ctx.audit({
    action: 'import.validated',
    entityType: 'import_runs',
    entityId: runId,
    after: { rows_valid: valid, rows_invalid: invalid },
  });
  return {
    id: runId,
    rowsTotal: results.length,
    rowsValid: valid,
    rowsInvalid: invalid,
    errorsByCode,
    rows: results.slice(0, PREVIEW_ROWS),
  };
}

export async function confirmImport(ctx: TenantContext, runId: string): Promise<{ id: string }> {
  await ctx.requirePermission('import.create');
  const run = await lockRun(ctx, runId);
  if (run.status !== 'validated') throw new ConflictError('conflict');
  const counts = await ctx.db.query<{ rows_valid: number }>(
    'SELECT rows_valid FROM import_runs WHERE id = $1',
    [runId],
  );
  if (!counts.rows[0]?.rows_valid) throw new ConflictError('no_valid_rows');
  await ctx.db.query(
    `UPDATE import_runs SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_by = $2
     WHERE id = $1`,
    [runId, ctx.userId],
  );
  await ctx.audit({
    action: 'import.confirmed',
    entityType: 'import_runs',
    entityId: runId,
    after: { status: 'confirmed' },
  });
  await emitEvent(ctx.db, {
    eventType: 'import.confirmed',
    aggregateType: 'import_runs',
    aggregateId: runId,
    requestId: ctx.requestId,
    actorId: ctx.userId,
  });
  return { id: runId };
}

export async function cancelImport(ctx: TenantContext, runId: string): Promise<{ id: string }> {
  await ctx.requirePermission('import.create');
  const run = await lockRun(ctx, runId);
  if (!['uploaded', 'validated'].includes(run.status)) throw new ConflictError('conflict');
  await ctx.db.query(
    `UPDATE import_runs SET status = 'cancelled', payload_enc = NULL, payload_key_version = NULL,
            updated_by = $2
     WHERE id = $1`,
    [runId, ctx.userId],
  );
  await ctx.audit({
    action: 'import.cancelled',
    entityType: 'import_runs',
    entityId: runId,
    after: { status: 'cancelled' },
  });
  return { id: runId };
}

export async function listImports(ctx: TenantContext) {
  await ctx.requirePermission('import.read');
  const { rows } = await ctx.db.query<{
    id: string;
    status: string;
    file_format: string;
    rows_total: number;
    rows_valid: number;
    invoices_created: number;
    invoices_updated: number;
    exceptions_count: number;
    created_at: Date;
  }>(
    `SELECT id, status, file_format, rows_total, rows_valid, invoices_created, invoices_updated,
            exceptions_count, created_at
     FROM import_runs ORDER BY created_at DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    fileFormat: r.file_format,
    rowsTotal: r.rows_total,
    rowsValid: r.rows_valid,
    invoicesCreated: r.invoices_created,
    invoicesUpdated: r.invoices_updated,
    exceptionsCount: r.exceptions_count,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getImport(ctx: TenantContext, runId: string): Promise<ImportRunView> {
  await ctx.requirePermission('import.read');
  const { rows } = await ctx.db.query<{
    id: string;
    status: string;
    file_format: string;
    source_name: string;
    rows_total: number;
    rows_valid: number;
    rows_invalid: number;
    invoices_created: number;
    invoices_updated: number;
    invoices_unchanged: number;
    customers_created: number;
    exceptions_count: number;
    created_at: Date;
    completed_at: Date | null;
    event_status: string | null;
  }>(
    `SELECT r.id, r.status, r.file_format, s.name AS source_name, r.rows_total, r.rows_valid,
            r.rows_invalid, r.invoices_created, r.invoices_updated, r.invoices_unchanged,
            r.customers_created, r.exceptions_count, r.created_at, r.completed_at,
            (SELECT e.status FROM domain_events e
             WHERE e.aggregate_id = r.id AND e.event_type = 'import.confirmed'
             ORDER BY e.created_at DESC LIMIT 1) AS event_status
     FROM import_runs r JOIN data_sources s ON s.id = r.source_id
     WHERE r.id = $1`,
    [runId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  const errors = await ctx.db.query<{ row_number: number; field: string; error_code: string }>(
    `SELECT row_number, field, error_code FROM import_row_errors WHERE run_id = $1
     ORDER BY row_number, field LIMIT $2`,
    [runId, MAX_ERRORS_SHOWN],
  );
  const exceptions = await ctx.db.query<{
    id: string;
    kind: string;
    row_number: number | null;
    invoice_id: string | null;
    currency: string | null;
    old_amount: string | null;
    new_amount: string | null;
    status: string;
  }>(
    `SELECT id, kind, row_number, invoice_id, currency, old_amount, new_amount, status
     FROM reconciliation_exceptions WHERE run_id = $1 ORDER BY row_number NULLS LAST, created_at`,
    [runId],
  );
  const processing =
    r.status !== 'confirmed'
      ? r.status === 'completed' || r.status === 'rolled_back'
        ? 'done'
        : null
      : r.event_status === 'failed'
        ? 'failed'
        : r.event_status === 'processing'
          ? 'processing'
          : 'pending';
  return {
    id: r.id,
    status: r.status,
    fileFormat: r.file_format,
    sourceName: r.source_name,
    rowsTotal: r.rows_total,
    rowsValid: r.rows_valid,
    rowsInvalid: r.rows_invalid,
    invoicesCreated: r.invoices_created,
    invoicesUpdated: r.invoices_updated,
    invoicesUnchanged: r.invoices_unchanged,
    customersCreated: r.customers_created,
    exceptionsCount: r.exceptions_count,
    processing,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    errors: errors.rows.map((e) => ({
      rowNumber: e.row_number,
      field: e.field,
      code: e.error_code,
    })),
    exceptions: exceptions.rows.map((x) => ({
      id: x.id,
      kind: x.kind,
      rowNumber: x.row_number,
      invoiceId: x.invoice_id,
      currency: x.currency,
      oldAmount: x.old_amount,
      newAmount: x.new_amount,
      status: x.status,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// 6.4: files from the public onboarding package — staged until the implementation team opens them
// ---------------------------------------------------------------------------------------------

/**
 * A file of the client's data package into import_runs 'staged' (sealed like any upload), in the
 * CURRENT tenant (the package's tenant, set by the public endpoint). No member: created_by NULL.
 */
export async function stageImport(
  db: Queryable,
  keyring: MasterKeyring,
  tenantId: string,
  input: { fileName: string; format: 'csv' | 'xlsx'; content: string },
): Promise<{ id: string; rows: number }> {
  const bytes = Buffer.from(input.content, 'base64');
  if (bytes.length > MAX_FILE_BYTES) throw new ConflictError('file_too_large');
  const grid = parseFile(input.format, bytes);
  if (grid.length < 2) throw new ConflictError('no_valid_rows');
  const refs = await db.query<{ source: string; company: string }>(
    `SELECT (SELECT id FROM data_sources WHERE name = 'file-import' AND status = 'active') AS source,
            (SELECT id FROM tenant_companies ORDER BY is_default DESC, created_at LIMIT 1) AS company`,
  );
  const r = refs.rows[0];
  if (!r?.source || !r.company) throw new NotFoundError();
  const header = grid[0] ?? [];
  const columns = detectColumns(header);
  const mapping: Mapping = {
    columns,
    decimal: detectDecimal(grid, columns),
    dateOrder: detectDateOrder(grid, columns),
  };
  const id = crypto.randomUUID();
  const sealed = sealGrid(keyring, tenantId, id, grid);
  await db.query(
    `INSERT INTO import_runs (id, tenant_id, source_id, company_id, file_format, file_sha256, payload_enc,
                              payload_key_version, mapping, rows_total, status)
     VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, 'staged')`,
    [
      id,
      r.source,
      r.company,
      input.format,
      createHash('sha256').update(bytes).digest(),
      sealed.ciphertext,
      sealed.keyVersion,
      mapping,
      grid.length - 1,
    ],
  );
  return { id, rows: grid.length - 1 };
}

export type StagedImport = { id: string; rowsTotal: number; createdAt: string };

export async function listStaged(ctx: TenantContext): Promise<StagedImport[]> {
  await ctx.requirePermission('import.create');
  const { rows } = await ctx.db.query<{ id: string; rows_total: number; created_at: Date }>(
    `SELECT id, rows_total, created_at FROM import_runs WHERE status = 'staged' ORDER BY created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    rowsTotal: r.rows_total,
    createdAt: r.created_at.toISOString(),
  }));
}

/** The implementation team opens a staged file: it becomes a normal upload (wizard step 2). */
export async function unstageImport(
  ctx: TenantContext,
  id: string,
  keyring: MasterKeyring = getMasterKeyring(),
): Promise<ImportUpload> {
  await ctx.requirePermission('import.create');
  const { rows } = await ctx.db.query<{
    payload_enc: Buffer;
    payload_key_version: number;
    mapping: Mapping;
    rows_total: number;
  }>(
    `UPDATE import_runs SET status = 'uploaded', created_by = coalesce(created_by, $2)
     WHERE id = $1 AND status = 'staged'
     RETURNING payload_enc, payload_key_version, mapping, rows_total`,
    [id, ctx.userId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError();
  const grid = openGrid(keyring, ctx.tenantId, id, {
    ciphertext: r.payload_enc,
    keyVersion: r.payload_key_version,
  });
  await ctx.audit({
    action: 'import.unstaged',
    entityType: 'import_runs',
    entityId: id,
    after: { rows_total: r.rows_total },
  });
  return {
    id,
    headers: grid[0] ?? [],
    sample: grid.slice(1, 6),
    rowsTotal: r.rows_total,
    mapping: r.mapping,
    templateUsed: false,
  };
}
