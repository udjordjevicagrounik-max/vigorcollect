import { describe, expect, it } from 'vitest';
import { classifyHeader, pseudonym, pseudonymizeGrid } from '../../scripts/pseudonymize';
import { parseCsv } from '@/server/imports/csv';
import { detectColumns } from '@/server/imports/rows';
import { genericTemplateCsv } from '@/server/library/import-templates';

const key = Buffer.from('k'.repeat(40));
const other = Buffer.from('o'.repeat(40));

describe('pseudonymize (6.5, rule 24)', () => {
  it('classifies the generic template: names, ids and codes replaced; money, dates, country kept', () => {
    const header = parseCsv(genericTemplateCsv(), 5)[0] ?? [];
    const kinds = Object.fromEntries(header.map((h) => [h, classifyHeader(h)]));
    expect(kinds).toMatchObject({
      'Naziv kupca': 'name',
      'PIB kupca': 'identifier',
      'Matični broj': 'identifier',
      'Šifra kupca': 'code',
      'Ukupan iznos': 'keep',
      Otvoreno: 'keep',
      'Datum dospeća': 'keep',
      Država: 'keep',
      'Fizičko lice': 'keep',
      'Broj fakture': 'keep',
      'Oznaka valute': 'keep',
    });
    for (const h of ['customer_country', 'customer_is_natural_person', 'amount_open', 'due_date'])
      expect(classifyHeader(h), h).toBe('keep');
    expect(classifyHeader('E-mail')).toBe('email');
    expect(classifyHeader('Kontakt osoba')).toBe('person');
    expect(classifyHeader('Napomena')).toBe('note');
  });

  it('is deterministic per key, keeps the identifier shape, never leaks the original', () => {
    expect(pseudonym(key, 'identifier', '101234567')).toBe(
      pseudonym(key, 'identifier', '101234567'),
    );
    expect(pseudonym(key, 'identifier', '101234567')).not.toBe(
      pseudonym(other, 'identifier', '101234567'),
    );
    expect(pseudonym(key, 'identifier', '101234567')).toMatch(/^[1-9]\d{8}$/);
    expect(pseudonym(key, 'identifier', '0101990710011')).toMatch(/^\d{13}$/);
    expect(pseudonym(key, 'name', 'Agrounik d.o.o.')).toMatch(/^Kupac [0-9A-F]{6} d\.o\.o\.$/);
    expect(pseudonym(key, 'email', 'pera@firma.rs')).toMatch(/@example\.invalid$/);
    expect(pseudonym(key, 'note', 'zvati Peru 064 123')).toBe('');
  });

  it('a whole file: header and business columns unchanged, still imports the same columns', () => {
    const grid = parseCsv(
      'Broj fakture;Naziv kupca;PIB kupca;Datum dospeća;Ukupan iznos;E-mail\r\n' +
        '2026-1;Agrounik d.o.o.;101234567;01.10.2026;120.000,00;pera@agrounik.rs\r\n' +
        '2026-2;Agrounik d.o.o.;101234567;15.10.2026;5.000,50;pera@agrounik.rs\r\n',
      10,
    );
    const { grid: out, report } = pseudonymizeGrid(key, grid);
    expect(out[0]).toEqual(grid[0]);
    expect(report.rows).toBe(2);
    expect(out[1]?.[0]).toBe('2026-1');
    expect(out[1]?.slice(3, 5)).toEqual(['01.10.2026', '120.000,00']);
    expect(out[1]?.[1]).toBe(out[2]?.[1]); // same customer → same pseudonym
    expect(out[1]?.[2]).toBe(out[2]?.[2]);
    const text = JSON.stringify(out.slice(1));
    for (const secret of ['Agrounik', '101234567', 'pera@']) expect(text).not.toContain(secret);
    expect(detectColumns(out[0] ?? [])).toEqual(detectColumns(grid[0] ?? []));
  });
});
