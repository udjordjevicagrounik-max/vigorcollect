/**
 * Pseudonymize an ERP export for staging and demos (task 6.5, rule 24): names, tax and
 * registration numbers, customer codes and contacts are replaced DETERMINISTICALLY — the same
 * input value gives the same pseudonym in every file and on every run with the same key, so an
 * invoice file and a customer file still join. Amounts, dates, currencies, invoice numbers and
 * every column it does not recognise stay as they are. Identifiers keep their SHAPE (9 digits stay
 * 9 digits, 13 stay 13) so the import classifies companies and natural persons the same way.
 *
 *   PSEUDONYMIZE_KEY=<from the vault> npx tsx scripts/pseudonymize.ts <file.csv|xlsx>... [--out dir]
 *
 * Output: <name>.pseudo.csv (";" separator) next to the input or in --out. The script prints one
 * line per column (header → action) and counts — never a value, never the key. Free-text columns
 * (notes) are emptied: they may hold anything. The key lives in the vault; without it the mapping
 * cannot be reversed or repeated.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseCsv } from '../src/server/imports/csv';
import { readXlsx } from '../src/server/imports/xlsx';

export type ColumnKind =
  | 'name'
  | 'person'
  | 'identifier'
  | 'code'
  | 'email'
  | 'phone'
  | 'address'
  | 'account'
  | 'note'
  | 'keep';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'dj')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Header words → kind. Order matters: the first rule that matches wins.
const RULES: [ColumnKind, RegExp][] = [
  // Business facts the import needs as they are (country, the natural-person flag, money, dates,
  // invoice and payment references) — checked first so "customer country" is never a name.
  [
    'keep',
    /\b(country|drzava|natural person|fizicko|potrosac|valuta|currency|datum|date|dospece|iznos|amount|total|ukupno|saldo|otvoreno|open|balance|dug|preostalo|osnovica|net|pdv|tax amount|vat amount|broj fakture|broj racuna|invoice|faktura|poziv na broj|narudzbenica|order|status)\b/,
  ],
  ['email', /\b(e ?mail|mail)\b/],
  ['phone', /\b(telefon|tel|phone|mobilni|mob|fax|faks)\b/],
  ['account', /\b(iban|tekuci racun|racun kupca|bank account|account number|ziro racun)\b/],
  ['address', /\b(adresa|address|ulica|street)\b/],
  ['note', /\b(napomena|note|notes|komentar|comment|opis)\b/],
  ['person', /\b(kontakt|contact|osoba|ime|prezime|first name|last name|person)\b/],
  ['identifier', /\b(pib|jmbg|tax id|tax_id|vat id|vat_id|maticni broj|mb|registration number)\b/],
  ['code', /\b(sifra kupca|id kupca|customer id|customer external id|customer_id)\b/],
  ['name', /\b(kupac|naziv kupca|naziv|customer|customer name|firma|company|partner)\b/],
];

export function classifyHeader(header: string): ColumnKind {
  const h = fold(header).replace(/_/g, ' ');
  for (const [kind, re] of RULES) if (re.test(h)) return kind;
  return 'keep';
}

function digest(key: Buffer, kind: string, value: string): Buffer {
  return createHmac('sha256', key).update(`${kind}\u0000${value.trim().toLowerCase()}`).digest();
}

/** Digits of the same length (leading digit never 0 when the original's was not). */
function digits(key: Buffer, kind: string, value: string, length: number, keepLeading: boolean) {
  let out = '';
  let block = digest(key, kind, value);
  let i = 0;
  while (out.length < length) {
    if (i >= block.length) {
      block = createHmac('sha256', key).update(block).digest();
      i = 0;
    }
    out += String((block[i] ?? 0) % 10);
    i += 1;
  }
  if (keepLeading && out.startsWith('0')) out = `${((block[0] ?? 1) % 9) + 1}${out.slice(1)}`;
  return out;
}

const LEGAL_FORMS = /\b(d\.?o\.?o\.?|a\.?d\.?|pr\.?|szr|str|zz|ad|doo|ltd|gmbh|llc)\s*$/i;

/** One cell → its pseudonym (deterministic for the key, kind and value). */
export function pseudonym(key: Buffer, kind: ColumnKind, value: string): string {
  const v = value.trim();
  if (kind === 'keep' || v === '') return value;
  const tag = digest(key, kind, v).toString('hex').slice(0, 6).toUpperCase();
  switch (kind) {
    case 'name': {
      const form = LEGAL_FORMS.exec(v)?.[0]?.trim();
      return form ? `Kupac ${tag} ${form}` : `Kupac ${tag}`;
    }
    case 'person':
      return `Osoba ${tag}`;
    case 'email':
      return `k-${tag.toLowerCase()}@example.invalid`;
    case 'note':
      return '';
    case 'address':
      return `Ulica ${tag} ${(parseInt(tag.slice(0, 2), 16) % 120) + 1}`;
    case 'identifier':
    case 'account':
    case 'phone':
    case 'code':
      // Keep the shape: every digit replaced (same count), letters and separators kept.
      return v.replace(/\d+/g, (run, offset: number) =>
        digits(key, `${kind}:${offset}`, v, run.length, run[0] !== '0'),
      );
  }
}

export type Report = { columns: { header: string; kind: ColumnKind }[]; rows: number };

export function pseudonymizeGrid(
  key: Buffer,
  grid: string[][],
): { grid: string[][]; report: Report } {
  const header = grid[0] ?? [];
  const kinds = header.map(classifyHeader);
  const out = [
    header,
    ...grid.slice(1).map((row) => row.map((cell, i) => pseudonym(key, kinds[i] ?? 'keep', cell))),
  ];
  return {
    grid: out,
    report: {
      columns: header.map((h, i) => ({ header: h, kind: kinds[i] ?? 'keep' })),
      rows: grid.length - 1,
    },
  };
}

export function toCsv(grid: string[][]): string {
  const cell = (c: string) => (/[;"\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return `${grid.map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

export function keyFromEnv(raw: string | undefined): Buffer {
  if (!raw || raw.length < 32)
    throw new Error(
      'PSEUDONYMIZE_KEY is missing or shorter than 32 characters (vault, never the repo)',
    );
  return Buffer.from(raw, 'utf8');
}

const say = (line: string) => process.stdout.write(`${line}\n`);

function main(argv: string[]) {
  let outDir: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      outDir = argv[i + 1];
      i += 1;
    } else files.push(argv[i] ?? '');
  }
  if (files.length === 0) {
    console.error(
      'usage: PSEUDONYMIZE_KEY=… npx tsx scripts/pseudonymize.ts <file.csv|xlsx>... [--out dir]',
    );
    process.exit(2);
  }
  const key = keyFromEnv(process.env.PSEUDONYMIZE_KEY);
  for (const file of files) {
    const buf = readFileSync(file);
    const grid = /\.xlsx$/i.test(file)
      ? readXlsx(buf, 200_000)
      : parseCsv(buf.toString('utf8'), 200_000);
    const { grid: out, report } = pseudonymizeGrid(key, grid);
    const target = join(outDir ?? dirname(file), `${basename(file, extname(file))}.pseudo.csv`);
    writeFileSync(target, `\ufeff${toCsv(out)}`);
    say(`${basename(file)} → ${basename(target)}: ${report.rows} rows`);
    for (const c of report.columns)
      say(`  ${c.kind === 'keep' ? 'keep   ' : 'replace'}  ${c.header} (${c.kind})`);
  }
}

if (process.argv[1] && /pseudonymize\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
