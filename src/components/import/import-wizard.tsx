'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, type ChangeEvent } from 'react';
import { FormError, FormSuccess, type FormProblem } from '@/components/auth/form-message';
import { apiProblem } from '@/lib/api-problem';
import { formatAmount } from '@/lib/format-amount';
import { postJSON } from '@/lib/post-json';

// Import wizard (task 2.2), mobile-compact: 1 file → 2 mapping → 3 preview → 4 report.
// The file is read in the browser and sent as base64 JSON; parsing and validation run on the
// server (file content is untrusted input — rule 22). Amounts are shown from decimal strings.

const FIELDS = [
  'external_id',
  'number',
  'issue_date',
  'due_date',
  'currency',
  'amount_total',
  'amount_open',
  'amount_net',
  'amount_tax',
  'customer_tax_id',
  'customer_name',
  'customer_country',
  'customer_registration_number',
  'customer_external_id',
  'customer_is_natural_person',
  'buyer_reference',
  'order_reference',
] as const;
type Field = (typeof FIELDS)[number];
const REQUIRED: readonly Field[] = [
  'external_id',
  'number',
  'issue_date',
  'due_date',
  'amount_total',
  'customer_tax_id',
  'customer_name',
];

type Mapping = {
  columns: Partial<Record<Field, number>>;
  decimal: 'comma' | 'dot';
  dateOrder: 'dmy' | 'ymd';
};
type Upload = {
  id: string;
  headers: string[];
  sample: string[][];
  rowsTotal: number;
  mapping: Mapping;
  templateUsed: boolean;
};
type PreviewRow =
  | {
      rowNumber: number;
      ok: true;
      value: {
        externalId: string;
        number: string;
        dueDate: string;
        currency: string;
        amountTotal: string;
        amountOpen: string;
        customerName: string;
      };
    }
  | { rowNumber: number; ok: false; errors: { field: string; code: string }[] };
type Preview = {
  id: string;
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  errorsByCode: Record<string, number>;
  rows: PreviewRow[];
};
type Report = {
  id: string;
  status: string;
  processing: 'pending' | 'processing' | 'failed' | 'done' | null;
  invoicesCreated: number;
  invoicesUpdated: number;
  invoicesUnchanged: number;
  customersCreated: number;
  exceptionsCount: number;
  rowsInvalid: number;
  errors: { rowNumber: number; field: string; code: string }[];
  exceptions: {
    id: string;
    kind: string;
    rowNumber: number | null;
    currency: string | null;
    oldAmount: string | null;
    newAmount: string | null;
  }[];
};

const DECIMALS = [
  { value: 'comma', label: 'mapping.decimalComma' },
  { value: 'dot', label: 'mapping.decimalDot' },
] as const;
const DATE_ORDERS = [
  { value: 'dmy', label: 'mapping.dmy' },
  { value: 'ymd', label: 'mapping.ymd' },
] as const;

type CodeKey =
  keyof (typeof import('../../../messages/sr-Latn.json'))['importPage']['wizard']['codes'];
type ExceptionKey =
  keyof (typeof import('../../../messages/sr-Latn.json'))['importPage']['wizard']['exceptionKinds'];

const primary =
  'min-h-11 rounded-md bg-brand-green px-4 font-medium text-surface hover:bg-brand-green-deep disabled:opacity-60';
const secondary =
  'min-h-11 rounded-md border border-brand-purple px-4 text-sm font-medium text-brand-purple hover:bg-brand-purple-soft disabled:opacity-60';
const card = 'rounded-lg border border-border bg-surface p-4';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function ImportWizard({ canRollback }: { canRollback: boolean }) {
  const t = useTranslations('importPage.wizard');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);

  async function call<T>(path: string, body: unknown): Promise<T | null> {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const res = await postJSON(path, body);
    setBusy(false);
    if (res.status >= 200 && res.status < 300) return res.json as T;
    setProblem(apiProblem(res, tErrors));
    return null;
  }

  async function sendFile() {
    if (!file) return;
    const format = /\.xlsx$/i.test(file.name) ? 'xlsx' : 'csv';
    const content = toBase64(await file.arrayBuffer());
    const res = await call<Upload>('/api/imports', { fileName: file.name, format, content });
    if (res) {
      setUpload(res);
      setMapping(res.mapping);
      setStep(2);
    }
  }

  async function validate() {
    if (!upload || !mapping) return;
    const res = await call<Preview>(`/api/imports/${upload.id}/validate`, { mapping });
    if (res) {
      setPreview(res);
      setStep(3);
    }
  }

  async function confirm() {
    if (!upload) return;
    const res = await call<{ id: string }>(`/api/imports/${upload.id}/confirm`, {});
    if (res) setStep(4);
  }

  async function rollback() {
    if (!upload) return;
    const res = await call<{ reverted: number; blocked: number }>(
      `/api/imports/${upload.id}/rollback`,
      {},
    );
    setConfirmRollback(false);
    if (res) {
      setNotice(t('rolledBack', { reverted: res.reverted, blocked: res.blocked }));
      setReport(null);
      router.refresh();
    }
  }

  // Step 4: the worker applies the run; poll the report until it is done (or failed).
  useEffect(() => {
    if (step !== 4 || !upload) return;
    let stop = false;
    const tick = async () => {
      const res = await fetch(`/api/imports/${upload.id}`, { credentials: 'same-origin' });
      if (!res.ok || stop) return;
      const body = (await res.json()) as Report;
      setReport(body);
      if (body.processing === 'done' || body.processing === 'failed') {
        router.refresh();
        return;
      }
      setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [step, upload, router]);

  function setColumn(field: Field, event: ChangeEvent<HTMLSelectElement>) {
    if (!mapping) return;
    const columns = { ...mapping.columns };
    const value = event.target.value;
    const next = Object.fromEntries(Object.entries(columns).filter(([key]) => key !== field));
    setMapping({
      ...mapping,
      columns: value === '' ? next : { ...next, [field]: Number.parseInt(value, 10) },
    });
  }

  const codeLabel = (code: string) =>
    t.has(`codes.${code as CodeKey}`) ? t(`codes.${code as CodeKey}`) : code;

  const missing = mapping ? REQUIRED.filter((f) => mapping.columns[f] === undefined) : [];
  const recognized = mapping ? Object.keys(mapping.columns).length : 0;

  return (
    <div className="flex flex-col gap-4" data-import-step={step}>
      <ol className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4" aria-label={t('stepsLabel')}>
        {([1, 2, 3, 4] as const).map((n) => (
          <li
            key={n}
            aria-current={step === n ? 'step' : undefined}
            className={`rounded-md border px-3 py-2 ${step === n ? 'border-brand-green font-semibold text-brand-green' : 'border-border text-text-muted'}`}
          >
            {t(`steps.${n}`)}
          </li>
        ))}
      </ol>
      <FormError problem={problem} />
      <FormSuccess message={notice} />

      {step === 1 ? (
        <section className={card} aria-labelledby="import-file">
          <h2 id="import-file" className="font-semibold text-text">
            {t('file.title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">{t('file.hint')}</p>
          <p className="mt-1 text-sm text-text-muted">{t('file.columns')}</p>
          <label htmlFor="import-file-input" className="mt-3 block text-sm font-medium text-text">
            {t('file.label')}
          </label>
          <input
            id="import-file-input"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block min-h-11 w-full text-sm text-text"
          />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={primary}
              disabled={!file || busy}
              onClick={() => void sendFile()}
            >
              {busy ? t('working') : t('next')}
            </button>
          </div>
        </section>
      ) : null}

      {step === 2 && upload && mapping ? (
        <section className={card} aria-labelledby="import-mapping">
          <h2 id="import-mapping" className="font-semibold text-text">
            {t('mapping.title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('mapping.summary', { rows: upload.rowsTotal, recognized, total: FIELDS.length })}
            {upload.templateUsed ? ` ${t('mapping.template')}` : ''}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('mapping.decimal')}
              <select
                className="min-h-11 rounded-md border border-border bg-surface px-3"
                value={mapping.decimal}
                onChange={(e) =>
                  setMapping({ ...mapping, decimal: e.target.value as Mapping['decimal'] })
                }
              >
                {DECIMALS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {t(d.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-text">
              {t('mapping.dateOrder')}
              <select
                className="min-h-11 rounded-md border border-border bg-surface px-3"
                value={mapping.dateOrder}
                onChange={(e) =>
                  setMapping({ ...mapping, dateOrder: e.target.value as Mapping['dateOrder'] })
                }
              >
                {DATE_ORDERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {t(d.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul className="mt-4 flex flex-col gap-2">
            {FIELDS.map((field) => {
              const col = mapping.columns[field];
              const example = col === undefined ? '' : (upload.sample[0]?.[col] ?? '');
              return (
                <li
                  key={field}
                  className="grid gap-1 md:grid-cols-[14rem_1fr_1fr] md:items-center"
                  data-map-field={field}
                >
                  <label htmlFor={`map-${field}`} className="text-sm font-medium text-text">
                    {t(`fields.${field}`)}
                    {REQUIRED.includes(field) ? (
                      <span className="text-status-danger-fg"> *</span>
                    ) : null}
                  </label>
                  <select
                    id={`map-${field}`}
                    className="min-h-11 rounded-md border border-border bg-surface px-3 text-text"
                    value={col === undefined ? '' : String(col)}
                    onChange={(e) => setColumn(field, e)}
                  >
                    <option value="">{t('mapping.none')}</option>
                    {upload.headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={String(i)}>
                        {h || t('mapping.column', { n: i + 1 })}
                      </option>
                    ))}
                  </select>
                  <span className="truncate text-sm text-text-muted">{example}</span>
                </li>
              );
            })}
          </ul>
          {missing.length ? (
            <p className="mt-3 text-sm text-status-danger-fg" role="status">
              {t('mapping.missing', { fields: missing.map((f) => t(`fields.${f}`)).join(', ') })}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={() => setStep(1)}>
              {t('back')}
            </button>
            <button
              type="button"
              className={primary}
              disabled={busy || missing.length > 0}
              onClick={() => void validate()}
            >
              {busy ? t('working') : t('next')}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 && preview ? (
        <section className={card} aria-labelledby="import-preview">
          <h2 id="import-preview" className="font-semibold text-text">
            {t('preview.title')}
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3">
            <div className="rounded-md border border-border p-3">
              <dt className="text-sm text-text-muted">{t('preview.valid')}</dt>
              <dd className="text-xl font-semibold text-brand-green" data-preview-valid>
                {preview.rowsValid}
              </dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-sm text-text-muted">{t('preview.invalid')}</dt>
              <dd className="text-xl font-semibold text-status-danger-fg" data-preview-invalid>
                {preview.rowsInvalid}
              </dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-sm text-text-muted">{t('preview.total')}</dt>
              <dd className="text-xl font-semibold text-text">{preview.rowsTotal}</dd>
            </div>
          </dl>
          {Object.keys(preview.errorsByCode).length ? (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm">
              {Object.entries(preview.errorsByCode).map(([code, n]) => (
                <li
                  key={code}
                  className="rounded-md bg-status-danger-bg px-2 py-1 text-status-danger-fg"
                >
                  {codeLabel(code)} · {n}
                </li>
              ))}
            </ul>
          ) : null}
          <h3 className="mt-4 text-sm font-semibold text-text">
            {t('preview.first', { n: preview.rows.length })}
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {preview.rows.map((row) => (
              <li
                key={row.rowNumber}
                className="rounded-md border border-border p-3 text-sm"
                data-preview-row={row.ok ? 'ok' : 'error'}
              >
                <span className="text-text-muted">{t('preview.row', { n: row.rowNumber })}</span>{' '}
                {row.ok ? (
                  <span className="text-text">
                    {row.value.number} · {row.value.customerName} ·{' '}
                    {t('preview.due', { date: row.value.dueDate })} ·{' '}
                    <strong>
                      {formatAmount(row.value.amountOpen, row.value.currency, locale)}
                    </strong>
                  </span>
                ) : (
                  <span className="text-status-danger-fg">
                    {row.errors
                      .map((e) => `${t(`fields.${e.field as Field}`)}: ${codeLabel(e.code)}`)
                      .join('; ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={() => setStep(2)}>
              {t('back')}
            </button>
            <button
              type="button"
              className={primary}
              disabled={busy || preview.rowsValid === 0}
              onClick={() => void confirm()}
            >
              {t('preview.confirm', { n: preview.rowsValid })}
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section className={card} aria-labelledby="import-report" aria-live="polite">
          <h2 id="import-report" className="font-semibold text-text">
            {t('report.title')}
          </h2>
          {!report || report.processing === 'pending' || report.processing === 'processing' ? (
            <p className="mt-2 text-text-muted" data-import-processing>
              {t('report.processing')}
            </p>
          ) : report.processing === 'failed' ? (
            <p className="mt-2 text-status-danger-fg">{t('report.failed')}</p>
          ) : (
            <>
              <p className="mt-2 text-text" data-import-done>
                {t('report.summary', {
                  created: report.invoicesCreated,
                  updated: report.invoicesUpdated,
                  unchanged: report.invoicesUnchanged,
                  customers: report.customersCreated,
                  skipped: report.rowsInvalid,
                })}
              </p>
              {report.exceptions.length ? (
                <>
                  <h3 className="mt-3 text-sm font-semibold text-text">
                    {t('report.exceptions', { n: report.exceptions.length })}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-2 text-sm">
                    {report.exceptions.map((x) => (
                      <li
                        key={x.id}
                        className="rounded-md border border-status-warning-fg p-2 text-text"
                        data-exception={x.kind}
                      >
                        {x.rowNumber ? `${t('preview.row', { n: x.rowNumber })} · ` : ''}
                        {t(`exceptionKinds.${x.kind as ExceptionKey}`)}
                        {x.currency && x.oldAmount && x.newAmount
                          ? ` · ${formatAmount(x.oldAmount, x.currency, locale)} → ${formatAmount(x.newAmount, x.currency, locale)}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/customers" className={`${primary} inline-flex items-center`}>
                  {t('report.toCustomers')}
                </Link>
                <button
                  type="button"
                  className={secondary}
                  onClick={() => {
                    setStep(1);
                    setUpload(null);
                    setPreview(null);
                    setReport(null);
                  }}
                >
                  {t('report.another')}
                </button>
                {canRollback && report.status === 'completed' ? (
                  confirmRollback ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-text">{t('report.rollbackConfirm')}</span>
                      <button
                        type="button"
                        className={secondary}
                        disabled={busy}
                        onClick={() => void rollback()}
                      >
                        {t('report.rollbackYes')}
                      </button>
                      <button
                        type="button"
                        className={secondary}
                        onClick={() => setConfirmRollback(false)}
                      >
                        {t('report.rollbackNo')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => setConfirmRollback(true)}
                    >
                      {t('report.rollback')}
                    </button>
                  )
                ) : null}
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
