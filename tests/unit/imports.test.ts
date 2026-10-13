import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/server/imports/csv';
import {
  detectColumns,
  detectDateOrder,
  detectDecimal,
  normalizeAmount,
  normalizeDate,
  validateRows,
  type Mapping,
} from '@/server/imports/rows';
import { classifyParty, parseYesNo } from '@/server/imports/party';
import { readXlsx, XlsxError } from '@/server/imports/xlsx';
import { buildXlsx } from './fixtures/xlsx-builder';

describe('imports: CSV', () => {
  it('detects ";" and keeps quoted delimiters, quotes and newlines', () => {
    const grid = parseCsv(
      '﻿Broj;Kupac;Iznos\r\nF-1;"Agro; d.o.o.";"1.234,56"\n"F-2";"Reč ""X""\nnovi red";10\n\n',
      10,
    );
    expect(grid).toEqual([
      ['Broj', 'Kupac', 'Iznos'],
      ['F-1', 'Agro; d.o.o.', '1.234,56'],
      ['F-2', 'Reč "X"\nnovi red', '10'],
    ]);
  });

  it('refuses an unterminated quote and a file over the row limit', () => {
    expect(() => parseCsv('a;b\n"x;y', 10)).toThrow('unterminated_quote');
    expect(() => parseCsv('h\n1\n2\n3', 2)).toThrow('too_large');
  });
});

describe('imports: XLSX without floats', () => {
  it('keeps the exact numeric text of the file', () => {
    const file = buildXlsx([
      ['Broj', 'Iznos', 'Datum'],
      ['F-1', { n: '1234.56' }, { n: '46307' }],
      ['F-&<2', { n: '9999999999999.99' }, '12.10.2026.'],
    ]);
    expect(readXlsx(file, 100)).toEqual([
      ['Broj', 'Iznos', 'Datum'],
      ['F-1', '1234.56', '46307'],
      ['F-&<2', '9999999999999.99', '12.10.2026.'],
    ]);
  });

  it('refuses a non-zip file and a sheet over the row limit', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all'), 10)).toThrow(XlsxError);
    const big = buildXlsx([['h'], ['1'], ['2'], ['3']]);
    expect(() => readXlsx(big, 2)).toThrow('too_large');
  });

  // Review S-12: an unbounded column reference padded every row up to that column (OOM).
  it('refuses a cell beyond the mappable columns before padding the row', () => {
    const sheet = (ref: string) =>
      buildXlsx([], {
        sheetXml: `<worksheet><sheetData><row r="1"><c r="${ref}"><v>1</v></c></row></sheetData></worksheet>`,
      });
    expect(readXlsx(sheet('GR1'), 10)).toEqual([[...Array<string>(199).fill(''), '1']]); // col 199
    expect(() => readXlsx(sheet('GS1'), 10)).toThrow('too_large'); // col 200
    expect(() => readXlsx(sheet('XFE1'), 10)).toThrow('too_large');
    expect(() => readXlsx(sheet('ZZZZZZ1'), 10)).toThrow('too_large');
  });

  // Review S-12: lazy regexes over unclosed elements were quadratic (event loop blocked).
  it('rejects unclosed rows in linear time', () => {
    const file = buildXlsx([], {
      sheetXml: `<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c>'.repeat(50_000)}</sheetData></worksheet>`,
    });
    const started = Date.now();
    expect(() => readXlsx(file, 100_000)).toThrow('corrupt');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('skips look-alike tags such as <rowBreaks>', () => {
    const file = buildXlsx([], {
      sheetXml:
        '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>' +
        '<rowBreaks count="0"/></worksheet>',
    });
    expect(readXlsx(file, 10)).toEqual([['', 'x']]);
  });
});

describe('imports: normalization', () => {
  it('amounts: separators by setting, never a float', () => {
    expect(normalizeAmount('1.234,56', 'comma')).toBe('1234.56');
    expect(normalizeAmount('1 234,5', 'comma')).toBe('1234.50');
    expect(normalizeAmount('1234.56', 'comma')).toBe('1234.56'); // exact XLSX text
    expect(normalizeAmount('1,234.56', 'dot')).toBe('1234.56');
    expect(normalizeAmount('12,34,5', 'comma')).toBeNull();
    expect(normalizeAmount('1e5', 'dot')).toBeNull();
    expect(normalizeAmount('0.30000000000000004', 'dot')).toBeNull();
    expect(normalizeAmount('12.3.4', 'dot')).toBeNull();
  });

  it('dates: ISO, d.m.y, serial; impossible dates refused', () => {
    expect(normalizeDate('2026-10-12', 'dmy')).toBe('2026-10-12');
    expect(normalizeDate('12.10.2026.', 'dmy')).toBe('2026-10-12');
    expect(normalizeDate('10/12/2026', 'ymd')).toBeNull();
    expect(normalizeDate('46307', 'dmy')).toBe('2026-10-12');
    expect(normalizeDate('31.02.2026', 'dmy')).toBeNull();
    expect(normalizeDate('sutra', 'dmy')).toBeNull();
  });

  it('detects columns from Serbian headers', () => {
    const header = [
      'Broj fakture',
      'Datum fakture',
      'Datum dospeća',
      'PIB',
      'Naziv kupca',
      'Iznos',
      'Saldo',
      'ID',
    ];
    expect(detectColumns(header)).toEqual({
      external_id: 7,
      number: 0,
      issue_date: 1,
      due_date: 2,
      amount_total: 5,
      amount_open: 6,
      customer_tax_id: 3,
      customer_name: 4,
    });
  });
});

describe('imports: row validation', () => {
  const grid = [
    ['id', 'broj', 'datum', 'valuta', 'iznos', 'otvoreno', 'pib', 'kupac'],
    ['A1', 'F-1', '01.09.2026', '30.09.2026', '1.000,00', '400,00', '100000001', 'Agro'],
    ['A2', 'F-2', '01.09.2026', '15.08.2026', '10,00', '', '100000001', 'Agro'],
    ['A1', 'F-3', '01.09.2026', '30.09.2026', '5,00', '', '100000002', 'Beta'],
    ['A4', '', 'x', '30.09.2026', '5,00', '9,00', '', 'Beta'],
  ];
  const columns = detectColumns(grid[0] ?? []);
  const mapping: Mapping = {
    columns: { ...columns, external_id: 0, due_date: 3 },
    decimal: detectDecimal(grid, columns),
    dateOrder: detectDateOrder(grid, columns),
  };

  it('valid rows become canonical values with defaults', () => {
    const [first] = validateRows(grid, mapping, { currency: 'RSD', country: 'RS' });
    expect(first).toEqual({
      rowNumber: 2,
      ok: true,
      value: expect.objectContaining({
        externalId: 'A1',
        issueDate: '2026-09-01',
        dueDate: '2026-09-30',
        currency: 'RSD',
        amountTotal: '1000.00',
        amountOpen: '400.00',
        customerCountry: 'RS',
      }),
    });
  });

  it('errors are codes per field, never values', () => {
    const [, second, third, fourth] = validateRows(grid, mapping, {
      currency: 'RSD',
      country: 'RS',
    });
    expect(second).toEqual({
      rowNumber: 3,
      ok: false,
      errors: [{ field: 'due_date', code: 'due_before_issue' }],
    });
    expect(third).toEqual({
      rowNumber: 4,
      ok: false,
      errors: [{ field: 'external_id', code: 'duplicate_in_file' }],
    });
    expect(fourth?.ok).toBe(false);
    expect(fourth && !fourth.ok ? fourth.errors : []).toEqual(
      expect.arrayContaining([
        { field: 'number', code: 'required' },
        { field: 'issue_date', code: 'invalid_date' },
        { field: 'customer_tax_id', code: 'required' },
      ]),
    );
  });

  it('cross-field checks run once the fields themselves are valid', () => {
    const rows = [
      grid[0] ?? [],
      ['A9', 'F-9', '01.09.2026', '30.09.2026', '5,00', '9,00', '1', 'Beta'],
    ];
    const [only] = validateRows(rows, mapping, { currency: 'RSD', country: 'RS' });
    expect(only).toEqual({
      rowNumber: 2,
      ok: false,
      errors: [{ field: 'amount_open', code: 'open_exceeds_total' }],
    });
  });
});

describe('imports: demo file (scripts/demo-import)', () => {
  it('is detected and validated completely with Serbian conventions', async () => {
    const { demoCsv } = await import('../../scripts/demo-import/generate');
    const grid = parseCsv(demoCsv(new Date(Date.UTC(2026, 9, 12))), 1000);
    const columns = detectColumns(grid[0] ?? []);
    expect(columns).toMatchObject({ due_date: 3, currency: 4, amount_total: 5, amount_open: 6 });
    const mapping: Mapping = {
      columns,
      decimal: detectDecimal(grid, columns),
      dateOrder: detectDateOrder(grid, columns),
    };
    const results = validateRows(grid, mapping, { currency: 'EUR', country: 'RS' });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(40);
  });
});

// Review S-02: who is the customer of a row — by the country rules and the optional column.
describe('imports: party classification (natural persons never become companies)', () => {
  const RS = { natural_person: '^[0-9]{13}$', company: '^[0-9]{9}$' };
  it.each([
    ['0101990710006', null, 'consumer'],
    ['101234567', null, 'company'],
    ['DEMO-1', null, 'uncertain'],
    ['0101990710006', false, 'uncertain'], // "not a natural person" with a personal id
    ['101234567', true, 'sole_trader'],
    ['0101990710006', true, 'consumer'],
    ['ABC', true, 'uncertain'],
    ['DEMO-1', false, 'company'], // the file vouches; no rule contradicts
  ] as const)('RS %s, stated %s → %s', (id, stated, kind) => {
    expect(classifyParty(RS, id, stated)).toBe(kind);
  });

  it('a country without rules cannot be judged unless the file says so', () => {
    expect(classifyParty({}, '123456789', null)).toBe('uncertain');
    expect(classifyParty({}, '123456789', false)).toBe('company');
    expect(classifyParty({ natural_person: '([' }, '1', null)).toBe('uncertain'); // broken rule
  });

  it('the column: yes / no / empty, anything else is a row error', () => {
    expect(['da', 'Yes', 'X', ''].map(parseYesNo)).toEqual([true, true, true, null]);
    expect(['ne', 'NO', '0'].map(parseYesNo)).toEqual([false, false, false]);
    expect(parseYesNo('možda')).toBe('invalid');
  });
});
