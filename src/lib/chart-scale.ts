// Chart geometry (6.2): values arrive as decimal STRINGS; their share of the largest one is
// computed on integers (hundredths as BigInt) — only the final 0..1 share is a JS number, used
// for pixels, never for money (rule 18).

function hundredths(decimal: string | null | undefined): bigint {
  const s = (decimal ?? '0').trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) return 0n;
  const frac = ((m[3] ?? '') + '00').slice(0, 2);
  const v = BigInt(m[2] ?? '0') * 100n + BigInt(frac);
  return m[1] ? -v : v;
}

/** Share of each value in [0, 1] relative to the largest absolute value (negatives as 0). */
export function shares(values: readonly (string | null | undefined)[]): number[] {
  const ints = values.map(hundredths);
  const max = ints.reduce((a, b) => (b > a ? b : a), 0n);
  if (max <= 0n) return ints.map(() => 0);
  return ints.map((v) => (v <= 0n ? 0 : Number((v * 10000n) / max) / 10000));
}

/** Sum of decimal strings as a decimal string (two places). */
export function sumDecimals(values: readonly (string | null | undefined)[]): string {
  const total = values.map(hundredths).reduce((a, b) => a + b, 0n);
  const neg = total < 0n;
  const abs = neg ? -total : total;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** a − b as a decimal string, and the change in % (one decimal) or null when b is 0. */
export function delta(
  a: string | null,
  b: string | null,
): { diff: string; percent: string | null } {
  const x = hundredths(a);
  const y = hundredths(b);
  const d = x - y;
  const neg = d < 0n;
  const abs = neg ? -d : d;
  const diff = `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  if (y === 0n) return { diff, percent: null };
  const p = (d * 1000n) / (y < 0n ? -y : y);
  const pn = p < 0n;
  const pa = pn ? -p : p;
  return { diff, percent: `${pn ? '-' : ''}${pa / 10n}.${pa % 10n}` };
}
