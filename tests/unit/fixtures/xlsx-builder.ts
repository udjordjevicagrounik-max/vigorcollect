import { crc32, deflateRawSync } from 'node:zlib';

/** Tiny XLSX writer for tests: one sheet, inline strings + numeric cells given as exact text. */
export function buildXlsx(rows: (string | { n: string })[][]): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((cells, r) => {
      const cs = cells
        .map((c, i) => {
          const ref = `${col(i)}${r + 1}`;
          if (typeof c === 'string') {
            const esc = c.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            return `<c r="${ref}" t="inlineStr"><is><t>${esc}</t></is></c>`;
          }
          return `<c r="${ref}"><v>${c.n}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Fakture" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/data.xml"/></Relationships>',
    'xl/worksheets/data.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
