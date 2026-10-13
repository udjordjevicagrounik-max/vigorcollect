import { IMPORT_FIELDS, REQUIRED_FIELDS, type ImportField } from '@/server/imports/rows';

/**
 * Import mapping library (6.4): the GENERIC template — Serbian headers the wizard recognises on
 * its own (rows.ts synonyms), ";" and decimal comma like Serbian Excel exports, one fictitious
 * example row. ERP-specific templates come only from real exports we have seen (BACKLOG): never
 * invented headers.
 */
export const GENERIC_HEADERS: Record<ImportField, string> = {
  external_id: 'ID fakture',
  number: 'Broj fakture',
  issue_date: 'Datum fakture',
  due_date: 'Datum dospeća',
  currency: 'Oznaka valute',
  amount_total: 'Ukupan iznos',
  amount_open: 'Otvoreno',
  amount_net: 'Osnovica',
  amount_tax: 'PDV',
  customer_tax_id: 'PIB kupca',
  customer_name: 'Naziv kupca',
  customer_country: 'Država',
  customer_registration_number: 'Matični broj',
  customer_external_id: 'Šifra kupca',
  customer_is_natural_person: 'Fizičko lice',
  buyer_reference: 'Poziv na broj',
  order_reference: 'Narudžbenica',
};

const EXAMPLE: Record<ImportField, string> = {
  external_id: 'F-2026-0001',
  number: '2026-0001',
  issue_date: '01.09.2026',
  due_date: '01.10.2026',
  currency: 'RSD',
  amount_total: '120.000,00',
  amount_open: '120.000,00',
  amount_net: '100.000,00',
  amount_tax: '20.000,00',
  customer_tax_id: '100000001',
  customer_name: 'Primer d.o.o.',
  customer_country: 'RS',
  customer_registration_number: '20000001',
  customer_external_id: 'K-001',
  customer_is_natural_person: 'ne',
  buyer_reference: '97 0001',
  order_reference: 'N-15',
};

export const isRequired = (f: ImportField) => REQUIRED_FIELDS.includes(f);

/** The generic template file (UTF-8 BOM so Excel opens the Serbian letters correctly). */
export function genericTemplateCsv(): string {
  const line = (cells: string[]) => cells.join(';');
  return `\ufeff${line(IMPORT_FIELDS.map((f) => GENERIC_HEADERS[f]))}\r\n${line(IMPORT_FIELDS.map((f) => EXAMPLE[f]))}\r\n`;
}
