import { describe, expect, it } from 'vitest';
import { parseEcbDaily } from '@/server/fx/rates-job';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-10-09'>
      <Cube currency='USD' rate='1.0812'/>
      <Cube currency='JPY' rate='162.35'/>
      <Cube currency='CHF' rate='0.9381'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('fx: ECB daily feed', () => {
  it('keeps rates as decimal strings with the reference date', () => {
    expect(parseEcbDaily(FEED)).toEqual({
      source: 'ECB',
      base: 'EUR',
      validOn: '2026-10-09',
      rates: [
        { quote: 'USD', rate: '1.0812' },
        { quote: 'JPY', rate: '162.35' },
        { quote: 'CHF', rate: '0.9381' },
      ],
    });
  });

  it('a feed without a date, without rates or with a malformed rate is refused', () => {
    expect(() => parseEcbDaily('<Cube/>')).toThrow('no reference date');
    expect(() => parseEcbDaily("<Cube time='2026-10-09'></Cube>")).toThrow('no rates');
    expect(() =>
      parseEcbDaily("<Cube time='2026-10-09'><Cube currency='USD' rate='1e3'/></Cube>"),
    ).toThrow('malformed rate');
  });
});
