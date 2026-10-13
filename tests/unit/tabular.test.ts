import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { amount, date, int, text, toCsv, toXlsx } from '@/server/exports/tabular';

// 5.2: our own CSV / XLSX writers — formula injection neutralised, amounts never through a float.

/** Reads one entry of a ZIP produced by zip() (local headers, deflate). */
function entry(zip: Buffer, name: string): string {
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const n = zip.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    if (n === name) return inflateRawSync(data).toString('utf8');
    at += 30 + nameLen + size;
  }
  throw new Error(`no ${name}`);
}

const table = {
  columns: ['Kupac', 'Iznos', 'Dana', 'Dospeće'],
  rows: [
    [text('=HYPERLINK("http://x")'), amount('12345678901234567.89'), int(5), date('2026-10-13')],
    [text('Đorđe, "Ćao"'), amount('-0.10'), int(null), date(null)],
    [text('+1 2'), amount('0.30'), int(0), text('@cmd')],
  ],
};

describe('tabular export writers (5.2)', () => {
  it('CSV: BOM, CRLF, quoting, formula cells get a leading apostrophe', () => {
    const csv = toCsv(table).toString('utf8');
    expect(csv.startsWith('﻿Kupac,Iznos,Dana,Dospeće\r\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",12345678901234567.89,5,2026-10-13\r\n`);
    expect(csv).toContain('"Đorđe, ""Ćao""",-0.10,,\r\n');
    expect(csv).toContain("'+1 2,0.30,0,'@cmd\r\n");
  });

  it('XLSX: a valid package; amounts are the exact decimal string, text is never a formula', () => {
    const xlsx = toXlsx(table, 'Izveštaj');
    expect(xlsx.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    const sheet = entry(xlsx, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<v>12345678901234567.89</v>');
    expect(sheet).toContain('<v>-0.10</v>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('=HYPERLINK(&quot;http://x&quot;)');
    expect(entry(xlsx, 'xl/workbook.xml')).toContain('name="Izveštaj"');
    expect(entry(xlsx, '[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml');
  });

  it('refuses an amount that is not a decimal string (no silent float)', () => {
    expect(() => toCsv({ columns: ['a'], rows: [[amount('1e3')]] })).toThrow();
    expect(() => toCsv({ columns: ['a'], rows: [[amount('NaN')]] })).toThrow();
  });
});
