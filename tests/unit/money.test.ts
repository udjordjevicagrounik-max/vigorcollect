import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  convert,
  formatMoney,
  fromMinor,
  money,
  MoneyError,
  sub,
  sum,
  toDecimal,
  toMinor,
} from '@/server/fx/money';

describe('money: decimal strings ↔ minor units', () => {
  it('parses strictly', () => {
    expect(toMinor('12')).toBe(1200n);
    expect(toMinor('12.5')).toBe(1250n);
    expect(toMinor('-0.01')).toBe(-1n);
    expect(toMinor('-0')).toBe(0n);
    expect(toMinor('9999999999999999.99')).toBe(999999999999999999n);
    for (const bad of ['', '1e3', '1.234', '1,5', '12.', '.5', '17 000', 'NaN', '10000000000000000']) {
      expect(() => toMinor(bad), bad).toThrow(MoneyError);
    }
  });

  it('formats canonically', () => {
    expect(fromMinor(123450n)).toBe('1234.50');
    expect(fromMinor(-5n)).toBe('-0.05');
    expect(fromMinor(0n)).toBe('0.00');
  });

  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(toDecimal(add(money('0.1', 'EUR'), money('0.2', 'EUR')))).toBe('0.30');
  });

  it('never mixes currencies', () => {
    expect(() => add(money('1', 'EUR'), money('1', 'RSD'))).toThrow('currency_mismatch');
    expect(() => compare(money('1', 'EUR'), money('1', 'RSD'))).toThrow('currency_mismatch');
    expect(() => money('1', 'eur')).toThrow('invalid_currency');
  });

  it('sums and subtracts beyond float precision', () => {
    const big = money('9007199254740993.01', 'RSD');
    expect(toDecimal(sub(big, money('0.01', 'RSD')))).toBe('9007199254740993.00');
    expect(toDecimal(sum([money('1.10', 'EUR'), money('2.20', 'EUR')], 'EUR'))).toBe('3.30');
  });
});

describe('money: frozen-rate conversion', () => {
  it('rounds half to even at the cent', () => {
    // 0.05 EUR × 0.5 = 0.025 → 0.02 (even); 0.07 × 0.5 = 0.035 → 0.04 (even)
    expect(toDecimal(convert(money('0.05', 'EUR'), '0.5', 'XXX'))).toBe('0.02');
    expect(toDecimal(convert(money('0.07', 'EUR'), '0.5', 'XXX'))).toBe('0.04');
    expect(toDecimal(convert(money('-0.05', 'EUR'), '0.5', 'XXX'))).toBe('-0.02');
  });

  it('EUR → RSD with a ten-decimal rate', () => {
    expect(convert(money('1000.00', 'EUR'), '117.1234567891', 'RSD')).toEqual({
      minor: 11712346n,
      currency: 'RSD',
    });
  });

  it('rejects a zero, negative or malformed rate', () => {
    for (const bad of ['0', '-1', '1e2', '', '1.12345678901']) {
      expect(() => convert(money('1', 'EUR'), bad, 'RSD'), bad).toThrow(MoneyError);
    }
  });
});

describe('money: display', () => {
  it('formats the exact decimal per locale', () => {
    expect(formatMoney(money('12345678901234.56', 'RSD'), 'sr-Latn')).toBe('12.345.678.901.234,56\u00a0RSD');
    expect(formatMoney(money('1234.5', 'EUR'), 'en')).toBe('€1,234.50');
  });
});
