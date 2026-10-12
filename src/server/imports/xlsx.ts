import { inflateRawSync } from 'node:zlib';

/**
 * Minimal XLSX reader (task 2.2) — first worksheet as a grid of STRINGS. Written in-house instead
 * of exceljs because exceljs turns numeric cells into JS numbers (floats); amounts must never pass
 * through a float (rule 18). Here a numeric cell keeps the exact decimal text of the file.
 *
 * Scope: ZIP (stored / deflate, no ZIP64, no encryption), shared + inline strings, numbers,
 * booleans, formula results (cached <v>). Dates stay Excel serial numbers ("45567"); the row
 * validator understands them. Hard limits guard against zip bombs and huge sheets.
 */

export class XlsxError extends Error {
  constructor(readonly reason: 'not_zip' | 'unsupported' | 'too_large' | 'no_sheet' | 'corrupt') {
    super(`xlsx: ${reason}`);
    this.name = 'XlsxError';
  }
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

type Entry = { method: number; compressedSize: number; size: number; offset: number };

function readEntries(zip: Buffer): Map<string, Entry> {
  const minEocd = 22;
  if (zip.length < minEocd) throw new XlsxError('not_zip');
  let eocd = -1;
  for (let i = zip.length - minEocd; i >= Math.max(0, zip.length - minEocd - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('not_zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new XlsxError('unsupported'); // ZIP64
  const entries = new Map<string, Entry>();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('corrupt');
    const flags = zip.readUInt16LE(p + 8);
    if (flags & 0x1) throw new XlsxError('unsupported'); // encrypted
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, {
      method: zip.readUInt16LE(p + 10),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      offset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(zip: Buffer, entries: Map<string, Entry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  if (e.size > MAX_ENTRY_BYTES) throw new XlsxError('too_large');
  const h = e.offset;
  if (h + 30 > zip.length || zip.readUInt32LE(h) !== 0x04034b50) throw new XlsxError('corrupt');
  const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28);
  const data = zip.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method !== 8) throw new XlsxError('unsupported');
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  } catch {
    throw new XlsxError('too_large');
  }
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITY[e] ?? '';
  });
}

/** Text of an <si> / <is> node: plain <t> or rich-text runs <r><t>, phonetic <rPh> ignored. */
function richText(node: string): string {
  const clean = node.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  return [...clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
    .map((m) => decodeXml(m[1] ?? ''))
    .join('');
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => richText(m[1] ?? ''));
}

function firstSheetPath(entries: Map<string, Entry>, zip: Buffer): string {
  const workbook = readEntry(zip, entries, 'xl/workbook.xml');
  const rels = readEntry(zip, entries, 'xl/_rels/workbook.xml.rels');
  const rid = workbook && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
      .map((m) => m[1] ?? '')
      .find((attrs) => new RegExp(`\\bId="${rid.replace(/[^\w]/g, '')}"`).test(attrs));
    const target = rel && /\bTarget="([^"]+)"/.exec(rel)?.[1];
    if (target) return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  throw new XlsxError('no_sheet');
}

/** "AB12" → zero-based column 27. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type Grid = string[][];

/** Reads the first worksheet; trailing empty rows are dropped. */
export function readXlsx(file: Buffer, maxRows: number): Grid {
  if (file.length < 4 || file.readUInt32LE(0) !== 0x04034b50) throw new XlsxError('not_zip');
  const entries = readEntries(file);
  const strings = sharedStrings(readEntry(file, entries, 'xl/sharedStrings.xml'));
  const sheet = readEntry(file, entries, firstSheetPath(entries, file));
  if (!sheet) throw new XlsxError('no_sheet');

  const grid: Grid = [];
  for (const row of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = row[1] ?? row[3] ?? '';
    const rowNumber = Number.parseInt(/\br="(\d+)"/.exec(attrs)?.[1] ?? `${grid.length + 1}`, 10);
    if (rowNumber > maxRows + 1) throw new XlsxError('too_large');
    const cells: string[] = [];
    let next = 0;
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = cell[1] ?? '';
      const body = cell[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(cAttrs)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = /\bt="(\w+)"/.exec(cAttrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = strings[Number.parseInt(v ?? '', 10)] ?? '';
      else if (type === 'inlineStr') value = richText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = decodeXml(v ?? ''); // n, str, e: the exact text of the file
      while (cells.length < col) cells.push('');
      cells[col] = value.trim();
    }
    while (grid.length < rowNumber - 1) grid.push([]);
    grid[rowNumber - 1] = cells;
  }
  while (grid.length && (grid.at(-1) ?? []).every((c) => c === '')) grid.pop();
  return grid;
}
