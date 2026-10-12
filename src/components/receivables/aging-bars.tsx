import { formatAmount } from '@/lib/format-amount';

type Bucket = { bucket: string; amount: string; count: number };

/**
 * Aging distribution as proportional bars. Widths are computed from integer cents (BigInt), so no
 * amount passes through a float (rule 18); the percent is only a layout value.
 */
export function AgingBars({
  aging,
  labels,
  currency,
  locale,
  hrefFor,
}: {
  aging: Bucket[];
  labels: Record<string, string>;
  currency: string;
  locale: string;
  hrefFor?: (bucket: string) => string;
}) {
  const cents = aging.map((a) => BigInt(a.amount.replace('.', '')));
  const max = cents.reduce((m, c) => (c > m ? c : m), 0n);
  return (
    <ul className="flex flex-col gap-2" data-aging>
      {aging.map((a, i) => {
        const width = max > 0n ? Number(((cents[i] ?? 0n) * 1000n) / max) / 10 : 0;
        const label = labels[a.bucket] ?? a.bucket;
        const row = (
          <>
            <span className="flex justify-between text-sm">
              <span className="text-text">{label}</span>
              <span className="font-medium text-text">
                {formatAmount(a.amount, currency, locale)}
              </span>
            </span>
            <span className="mt-1 block h-2 rounded bg-brand-purple-soft">
              <span className="block h-2 rounded bg-brand-green" style={{ width: `${width}%` }} />
            </span>
          </>
        );
        return (
          <li key={a.bucket} data-aging-bucket={a.bucket}>
            {hrefFor ? (
              <a href={hrefFor(a.bucket)} className="block hover:underline">
                {row}
              </a>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
