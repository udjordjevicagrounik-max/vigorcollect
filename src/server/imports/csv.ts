import type { Grid } from './xlsx';

/**
 * RFC 4180 CSV without a package (task 2.2): quoted fields, doubled quotes, CR/LF/CRLF, UTF-8 BOM.
 * The delimiter is detected from the header line (; , tab) — Serbian exports use ";" because ","
 * is the decimal separator. Every cell stays a string.
 */

export class CsvError extends Error {
  constructor(readonly reason: 'unterminated_quote' | 'too_large') {
    super(`csv: ${reason}`);
    this.name = 'CsvError';
  }
}

export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', ',', '\t'].map((d) => ({ d, n: header.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0] && counts[0].n > 0 ? counts[0].d : ';';
}

export function parseCsv(input: string, maxRows: number): Grid {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const grid: Grid = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (!(row.length === 1 && row[0] === '')) grid.push(row.map((c) => c.trim()));
    row = [];
    if (grid.length > maxRows + 1) throw new CsvError('too_large');
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (quoted) throw new CsvError('unterminated_quote');
  if (cell !== '' || row.length) endRow();
  return grid;
}
