import { z } from 'zod';
import { fromMinor, toMinor } from '@/server/fx/money';
import type { Grid } from './xlsx';

/**
 * Invoice import rows (task 2.2): target fields, column detection, mapping, Zod validation per
 * row. Every value stays a string; amounts become canonical decimals through money.ts (never a
 * float — rule 18), dates become ISO `date` strings (rule 26). Errors are (field, code) pairs —
 * never cell values, which may contain personal data.
 */

export const IMPORT_FIELDS = [
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
  'buyer_reference',
  'order_reference',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_FIELDS: readonly ImportField[] = [
  'external_id',
  'number',
  'issue_date',
  'due_date',
  'amount_total',
  'customer_tax_id',
  'customer_name',
];

export const mappingSchema = z.object({
  // target field → zero-based column index in the file
  columns: z.partialRecord(z.enum(IMPORT_FIELDS), z.int().min(0).max(199)),
  decimal: z.enum(['comma', 'dot']),
  dateOrder: z.enum(['dmy', 'ymd']),
});
export type Mapping = z.infer<typeof mappingSchema>;

/** Header synonyms (sr-Latn + en, ERP exports) for automatic column detection. */
const SYNONYMS: Record<ImportField, string[]> = {
  external_id: ['external_id', 'id', 'invoice_id', 'erp_id', 'id fakture', 'sifra fakture'],
  number: ['number', 'invoice_number', 'broj', 'broj fakture', 'broj racuna', 'invoice no'],
  issue_date: [
    'issue_date',
    'invoice_date',
    'datum',
    'datum fakture',
    'datum izdavanja',
    'datum racuna',
  ],
  due_date: [
    'due_date',
    'valuta',
    'valuta placanja',
    'datum valute',
    'datum dospeca',
    'dospece',
    'rok placanja',
  ],
  // "Valuta (plaćanja)" means the DUE DATE in Serbian accounting — never the currency.
  currency: ['currency', 'oznaka valute', 'vrsta valute', 'currency code', 'iso valuta'],
  amount_total: [
    'amount_total',
    'total',
    'iznos',
    'ukupno',
    'ukupan iznos',
    'iznos fakture',
    'amount',
  ],
  amount_open: [
    'amount_open',
    'open',
    'otvoreno',
    'saldo',
    'preostalo',
    'dug',
    'open amount',
    'balance',
  ],
  amount_net: ['amount_net', 'osnovica', 'net', 'iznos bez pdv'],
  amount_tax: ['amount_tax', 'pdv', 'tax', 'vat'],
  customer_tax_id: ['customer_tax_id', 'pib', 'tax_id', 'vat_id', 'pib kupca'],
  customer_name: ['customer_name', 'kupac', 'naziv kupca', 'customer', 'naziv'],
  customer_country: ['customer_country', 'drzava', 'country'],
  customer_registration_number: [
    'customer_registration_number',
    'mb',
    'maticni broj',
    'registration_number',
  ],
  customer_external_id: ['customer_external_id', 'sifra kupca', 'customer_id', 'id kupca'],
  buyer_reference: ['buyer_reference', 'referenca kupca', 'poziv na broj'],
  order_reference: ['order_reference', 'narudzbenica', 'order', 'po number'],
};

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'dj')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Suggests target field → column from the header row (exact synonym match, first wins). */
export function detectColumns(header: readonly string[]): Mapping['columns'] {
  const folded = header.map(fold);
  const columns: Mapping['columns'] = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const options = SYNONYMS[field].map(fold);
    const index = folded.findIndex((h, i) => !used.has(i) && options.includes(h));
    if (index >= 0) {
      columns[field] = index;
      used.add(index);
    }
  }
  return columns;
}

/** Decimal separator from the data: a trailing ",d" / ",dd" anywhere in amount columns → comma. */
export function detectDecimal(grid: Grid, columns: Mapping['columns']): Mapping['decimal'] {
  const amountCols = (['amount_total', 'amount_open', 'amount_net', 'amount_tax'] as const)
    .map((f) => columns[f])
    .filter((c): c is number => c !== undefined);
  const sample = grid.slice(1, 501).flatMap((row) => amountCols.map((c) => row[c] ?? ''));
  return sample.some((v) => /,\d{1,2}$/.test(v.replace(/\s/g, ''))) ? 'comma' : 'dot';
}

export function detectDateOrder(grid: Grid, columns: Mapping['columns']): Mapping['dateOrder'] {
  const c = columns.issue_date ?? columns.due_date;
  const sample = c === undefined ? [] : grid.slice(1, 51).map((row) => row[c] ?? '');
  return sample.some((v) => /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(v)) ? 'ymd' : 'dmy';
}

/** "1.234,56" / "1 234.56" / "-12" → canonical "1234.56"; null when not a clean amount. */
export function normalizeAmount(raw: string, decimal: Mapping['decimal']): string | null {
  let s = raw.replace(/[\s\u00a0\u202f']/g, '');
  if (s === '') return null;
  const [thousands, point] = decimal === 'comma' ? ['.', ','] : [',', '.'];
  // Exact XLSX numeric text always uses "." — accept it when it is the only separator.
  if (decimal === 'comma' && !s.includes(',') && /^-?\d+\.\d{1,2}$/.test(s)) return canonical(s);
  if (s.split(point).length > 2) return null;
  const [intPart = '', frac] = s.split(point);
  if (thousands && intPart.includes(thousands)) {
    if (!/^-?\d{1,3}(\.\d{3})+$|^-?\d{1,3}(,\d{3})+$/.test(intPart)) return null;
  }
  s = intPart.split(thousands).join('') + (frac === undefined ? '' : `.${frac}`);
  return canonical(s);
}

function canonical(s: string): string | null {
  try {
    return fromMinor(toMinor(s));
  } catch {
    return null;
  }
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** ISO date from "2026-10-12", "12.10.2026.", "12/10/2026" or an Excel serial ("46307"). */
export function normalizeDate(raw: string, order: Mapping['dateOrder']): string | null {
  const s = raw.trim().replace(/\.$/, '');
  let y: number;
  let m: number;
  let d: number;
  const serial = /^(\d{5})(?:\.0+)?$/.exec(s);
  const parts = /^(\d{1,4})[-./](\d{1,2})[-./](\d{1,4})$/.exec(s);
  if (serial) {
    const date = new Date(EXCEL_EPOCH_UTC + Number.parseInt(serial[1] ?? '', 10) * 86_400_000);
    y = date.getUTCFullYear();
    m = date.getUTCMonth() + 1;
    d = date.getUTCDate();
  } else if (parts) {
    const [a, b, c] = [parts[1], parts[2], parts[3]].map((p) => Number.parseInt(p ?? '', 10)) as [
      number,
      number,
      number,
    ];
    if ((parts[1] ?? '').length === 4 || order === 'ymd') [y, m, d] = [a, b, c];
    else [d, m, y] = [a, b, c];
  } else {
    return null;
  }
  if (y < 1990 || y > 2100) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export type ImportRow = {
  externalId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  amountTotal: string;
  amountOpen: string;
  amountNet: string | null;
  amountTax: string | null;
  customerTaxId: string;
  customerName: string;
  customerCountry: string;
  customerRegistrationNumber: string | null;
  customerExternalId: string | null;
  buyerReference: string | null;
  orderReference: string | null;
};

export type RowError = { field: ImportField; code: string };
export type RowResult =
  | { rowNumber: number; ok: true; value: ImportRow }
  | { rowNumber: number; ok: false; errors: RowError[] };

export type RowDefaults = { currency: string; country: string };

const text = (max: number) => z.string().trim().max(max, 'too_long');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'too_long')
    .transform((v) => (v === '' ? null : v));

function rowSchema(mapping: Mapping, defaults: RowDefaults) {
  const amount = (required: boolean) =>
    z.string().transform((v, ctx) => {
      if (v.trim() === '') {
        if (required) ctx.addIssue({ code: 'custom', message: 'required' });
        return null;
      }
      const n = normalizeAmount(v, mapping.decimal);
      if (n === null) ctx.addIssue({ code: 'custom', message: 'invalid_amount' });
      else if (n.startsWith('-')) ctx.addIssue({ code: 'custom', message: 'negative_amount' });
      return n;
    });
  const date = z.string().transform((v, ctx) => {
    if (v.trim() === '') {
      ctx.addIssue({ code: 'custom', message: 'required' });
      return '';
    }
    const d = normalizeDate(v, mapping.dateOrder);
    if (!d) ctx.addIssue({ code: 'custom', message: 'invalid_date' });
    return d ?? '';
  });
  const required = (max: number) => text(max).min(1, 'required');

  return z
    .object({
      external_id: required(200),
      number: required(100),
      issue_date: date,
      due_date: date,
      currency: z
        .string()
        .trim()
        .toUpperCase()
        .transform((v) => v || defaults.currency)
        .pipe(z.string().regex(/^[A-Z]{3}$/, 'invalid_currency')),
      amount_total: amount(true),
      amount_open: amount(false),
      amount_net: amount(false),
      amount_tax: amount(false),
      customer_tax_id: required(40),
      customer_name: required(200),
      customer_country: z
        .string()
        .trim()
        .toUpperCase()
        .transform((v) => v || defaults.country)
        .pipe(z.string().regex(/^[A-Z]{2}$/, 'invalid_country')),
      customer_registration_number: optionalText(40),
      customer_external_id: optionalText(200),
      buyer_reference: optionalText(200),
      order_reference: optionalText(200),
    })
    .superRefine((r, ctx) => {
      if (r.issue_date && r.due_date && r.due_date < r.issue_date) {
        ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'due_before_issue' });
      }
      if (r.amount_total && toMinor(r.amount_total) === 0n) {
        ctx.addIssue({ code: 'custom', path: ['amount_total'], message: 'zero_amount' });
      }
      if (r.amount_total && r.amount_open && toMinor(r.amount_open) > toMinor(r.amount_total)) {
        ctx.addIssue({ code: 'custom', path: ['amount_open'], message: 'open_exceeds_total' });
      }
      if (
        r.amount_total &&
        r.amount_net &&
        r.amount_tax &&
        toMinor(r.amount_net) + toMinor(r.amount_tax) !== toMinor(r.amount_total)
      ) {
        ctx.addIssue({ code: 'custom', path: ['amount_total'], message: 'net_tax_mismatch' });
      }
    });
}

export function missingRequired(mapping: Mapping): ImportField[] {
  return REQUIRED_FIELDS.filter((f) => mapping.columns[f] === undefined);
}

/** Validates every data row (row 1 = header). Duplicate external_id in one file is an error. */
export function validateRows(grid: Grid, mapping: Mapping, defaults: RowDefaults): RowResult[] {
  const schema = rowSchema(mapping, defaults);
  const seen = new Set<string>();
  return grid.slice(1).map((cells, i): RowResult => {
    const rowNumber = i + 2;
    const raw = Object.fromEntries(
      IMPORT_FIELDS.map((f) => {
        const c = mapping.columns[f];
        return [f, c === undefined ? '' : (cells[c] ?? '')];
      }),
    );
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => ({
        field: (issue.path[0] ?? 'external_id') as ImportField,
        code: /^[a-z][a-z_]{0,40}$/.test(issue.message) ? issue.message : 'invalid_value',
      }));
      return { rowNumber, ok: false, errors };
    }
    const r = parsed.data;
    if (seen.has(r.external_id)) {
      return {
        rowNumber,
        ok: false,
        errors: [{ field: 'external_id', code: 'duplicate_in_file' }],
      };
    }
    seen.add(r.external_id);
    return {
      rowNumber,
      ok: true,
      value: {
        externalId: r.external_id,
        number: r.number,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        currency: r.currency,
        amountTotal: r.amount_total ?? '0.00',
        amountOpen: r.amount_open ?? r.amount_total ?? '0.00',
        amountNet: r.amount_net,
        amountTax: r.amount_tax,
        customerTaxId: r.customer_tax_id,
        customerName: r.customer_name,
        customerCountry: r.customer_country,
        customerRegistrationNumber: r.customer_registration_number,
        customerExternalId: r.customer_external_id,
        buyerReference: r.buyer_reference,
        orderReference: r.order_reference,
      },
    };
  });
}
