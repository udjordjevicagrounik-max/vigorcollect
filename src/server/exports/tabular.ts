import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Our own CSV and XLSX writers (5.2, no package). A table is header + rows of typed cells:
 *   text   — written as text; in CSV a value starting with = + - @ TAB CR gets a leading
 *            apostrophe (formula injection, OWASP), in XLSX it is an inline string (never a formula);
 *   amount — a DECIMAL STRING from the database ("1234.50"), written as-is: CSV prints it, XLSX
 *            stores it as a number cell whose text is that string — no float on the way (rule 18);
 *   int    — a whole number;  date — "YYYY-MM-DD" (text in both, unambiguous).
 */

export type Cell =
  | { t: 'text'; v: string | null }
  | { t: 'amount'; v: string | null }
  | { t: 'int'; v: number | null }
  | { t: 'date'; v: string | null };
export type Table = { columns: string[]; rows: Cell[][] };

export const text = (v: string | null | undefined): Cell => ({ t: 'text', v: v ?? null });
export const amount = (v: string | null | undefined): Cell => ({ t: 'amount', v: v ?? null });
export const int = (v: number | null | undefined): Cell => ({ t: 'int', v: v ?? null });
export const date = (v: string | null | undefined): Cell => ({ t: 'date', v: v ?? null });

const DECIMAL = /^-?\d{1,18}(\.\d{1,10})?$/;

function plain(cell: Cell): string {
  if (cell.v === null) return '';
  if (cell.t === 'amount') {
    if (!DECIMAL.test(cell.v)) throw new Error('export: amount is not a decimal string');
    return cell.v;
  }
  if (cell.t === 'int') {
    if (!Number.isSafeInteger(cell.v)) throw new Error('export: not an integer');
    return String(cell.v);
  }
  return cell.v;
}

function csvField(cell: Cell): string {
  let s = plain(cell);
  if ((cell.t === 'text' || cell.t === 'date') && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180, CRLF, UTF-8 with BOM (Excel opens Latin diacritics correctly). */
export function toCsv(table: Table): Buffer {
  const lines = [
    table.columns.map((c) => csvField({ t: 'text', v: c })).join(','),
    ...table.rows.map((r) => r.map(csvField).join(',')),
  ];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`)]);
}

// ---------------------------------------------------------------------------------------------
// XLSX: a minimal OOXML workbook (one sheet, inline strings) in a ZIP built with node:zlib.
// ---------------------------------------------------------------------------------------------

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters other than TAB / LF / CR are not allowed in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(cell: Cell, ref: string, header = false): string {
  if (cell.v === null) return '';
  if (!header && (cell.t === 'amount' || cell.t === 'int'))
    return `<c r="${ref}"${cell.t === 'amount' ? ' s="1"' : ''}><v>${plain(cell)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header ? ' s="2"' : ''}><is><t xml:space="preserve">${xml(plain(cell))}</t></is></c>`;
}

function sheetXml(table: Table): string {
  const rows = [table.columns.map((c): Cell => ({ t: 'text', v: c })), ...table.rows].map(
    (cells, r) =>
      `<row r="${r + 1}">${cells.map((c, i) => cellXml(c, `${columnName(i)}${r + 1}`, r === 0)).join('')}</row>`,
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

const STATIC: Record<string, string> = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'xl/styles.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
};

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xml(sheetName.slice(0, 31).replace(/[[\]:*?/\\]/g, ' '))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
}

/** A ZIP (deflate, no data descriptors, fixed DOS time 1980-01-01) of `files`. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export function toXlsx(table: Table, sheetName = 'Export'): Buffer {
  return zip([
    ...Object.entries(STATIC).map(([name, s]) => ({ name, data: Buffer.from(s, 'utf8') })),
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(table), 'utf8') },
  ]);
}

export const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
