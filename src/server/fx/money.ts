/**
 * Money without floats (rule 18). An amount is a decimal string on the wire and in the database
 * (numeric(18,2); node-postgres returns numeric as a string) and a bigint of minor units (cents)
 * in arithmetic. `Number()`, `parseFloat()` and `toFixed()` never touch an amount — semgrep rule
 * no-float-amounts and tests/golden/no-float-amounts.test.ts enforce it.
 */

export const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
// numeric(18,2): at most 16 integer digits.
const DECIMAL = /^(-)?(\d{1,16})(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;
// Exchange rates: numeric(20,10).
const RATE = /^(\d{1,10})(?:\.(\d{1,10}))?$/;
const RATE_SCALE = 10;

export type Money = { readonly minor: bigint; readonly currency: string };

export class MoneyError extends Error {
  constructor(readonly reason: 'invalid_amount' | 'invalid_currency' | 'currency_mismatch' | 'invalid_rate') {
    super(`money: ${reason}`);
    this.name = 'MoneyError';
  }
}

/** Strict decimal string → minor units. "12", "12.5", "-0.01"; no exponent, no thousands sign. */
export function toMinor(amount: string): bigint {
  const m = DECIMAL.exec(amount.trim());
  if (!m) throw new MoneyError('invalid_amount');
  const [, sign, whole = '0', cents = ''] = m;
  const minor = BigInt(whole) * FACTOR + BigInt(cents.padEnd(SCALE, '0'));
  return sign && minor !== 0n ? -minor : minor;
}

/** Minor units → canonical decimal string with two decimals ("1234.50"). */
export function fromMinor(minor: bigint): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(SCALE, '0')}`;
}

export function money(amount: string, currency: string): Money {
  if (!CURRENCY.test(currency)) throw new MoneyError('invalid_currency');
  return { minor: toMinor(amount), currency };
}

export function zero(currency: string): Money {
  if (!CURRENCY.test(currency)) throw new MoneyError('invalid_currency');
  return { minor: 0n, currency };
}

/** Database value of a Money: the decimal string for a numeric(18,2) parameter. */
export function toDecimal(value: Money): string {
  return fromMinor(value.minor);
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError('currency_mismatch');
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function sum(values: readonly Money[], currency: string): Money {
  return values.reduce(add, zero(currency));
}

export const isZero = (value: Money): boolean => value.minor === 0n;
export const isPositive = (value: Money): boolean => value.minor > 0n;

/** Integer division rounded half to even (banker's rounding) — no bias over many conversions. */
function divRoundHalfEven(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  const twice = (an % ad) * 2n;
  if (twice > ad || (twice === ad && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/**
 * Converts with a frozen rate (rule 18): `rate` is "units of `to` per one unit of value.currency"
 * as a decimal string (exchange_rates.rate / invoices.fx_rate). Rounded half-even to the cent.
 */
export function convert(value: Money, rate: string, to: string): Money {
  if (!CURRENCY.test(to)) throw new MoneyError('invalid_currency');
  const m = RATE.exec(rate.trim());
  if (!m) throw new MoneyError('invalid_rate');
  const [, whole = '0', fraction = ''] = m;
  const scaled = BigInt(whole) * 10n ** BigInt(RATE_SCALE) + BigInt(fraction.padEnd(RATE_SCALE, '0'));
  if (scaled === 0n) throw new MoneyError('invalid_rate');
  return { minor: divRoundHalfEven(value.minor * scaled, 10n ** BigInt(RATE_SCALE)), currency: to };
}

/** Localized display. Intl formats the decimal STRING exactly (no float on the way). */
export function formatMoney(value: Money, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: SCALE,
    maximumFractionDigits: SCALE,
  }).format(fromMinor(value.minor) as Intl.StringNumericLiteral);
}
