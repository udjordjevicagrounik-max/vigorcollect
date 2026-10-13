import { describe, expect, it } from 'vitest';
import { pinPdfDates } from '@/server/documents/pdf';
import { htmlToText } from '@/server/mail/adapter';

describe('pinPdfDates (stable PDF checksum, task 3.3)', () => {
  it('pins creation/modification dates in place, keeping the byte length', () => {
    const raw = Buffer.from(
      "<</Producer (Skia/PDF m155)\n/CreationDate (D:20261013140949+02'00')\n/ModDate (D:20261013140950+02'00')>>",
      'latin1',
    );
    const out = pinPdfDates(raw, new Date('2026-01-02T03:04:05Z'));
    expect(out.length).toBe(raw.length);
    expect(out.toString('latin1')).toContain("/CreationDate (D:20260102030405+00'00')");
    expect(out.toString('latin1')).toContain("/ModDate (D:20260102030405+00'00')");
    expect(pinPdfDates(out, new Date('2026-01-02T03:04:05Z')).equals(out)).toBe(true);
  });
});

describe('htmlToText (collection mail plain-text part)', () => {
  it('keeps the text and line structure, decodes the escapes the renderer produced', () => {
    const text = htmlToText(
      '<p>Poštovani,</p><ul><li>F-1 — 1.234,50 €</li><li>F-2</li></ul><p>A &amp; B &lt;x&gt;</p>',
    );
    expect(text).toBe('Poštovani,\n- F-1 — 1.234,50 €\n- F-2\n\nA & B <x>');
  });
});
