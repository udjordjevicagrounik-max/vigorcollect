import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';

/**
 * fxRatesJob (rule 18, rule 25): daily reference rates into the platform table exchange_rates,
 * written only through fx_rates_upsert() (SECURITY DEFINER, vigor_worker may EXECUTE). A rate
 * once stored for (source, pair, valid_on) is never rewritten — documents freeze their own copy.
 * Sources come from jurisdiction_profiles.fx_source. Rates stay decimal strings end to end.
 *
 *   ECB — euro foreign exchange reference rates, base EUR (implemented);
 *   NBS — Narodna banka Srbije middle rate, base RSD (skeleton: logs, stores nothing yet).
 */

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export type RateSet = {
  source: string;
  base: string;
  validOn: string;
  rates: { quote: string; rate: string }[];
};

const RATE = /^\d{1,10}(?:\.\d{1,10})?$/;

/** Parses the ECB daily XML. Throws on anything unexpected — a bad feed never writes rates. */
export function parseEcbDaily(xml: string): RateSet {
  const time = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!time) throw new Error('ecb: no reference date in feed');
  const rates = [...xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([^'"]+)['"]\s*\/>/g)].map(
    ([, quote = '', rate = '']) => {
      if (!RATE.test(rate)) throw new Error('ecb: malformed rate');
      return { quote, rate };
    },
  );
  if (rates.length === 0) throw new Error('ecb: no rates in feed');
  return { source: 'ECB', base: 'EUR', validOn: time, rates };
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type FxDeps = { workerPool: Pool; appPool: Pool; fetch?: Fetcher };

async function fetchSet(source: string, fetcher: Fetcher): Promise<RateSet | null> {
  if (source === 'ECB') {
    const res = await fetcher(ECB_DAILY_URL);
    if (!res.ok) throw new Error(`ecb: HTTP ${res.status}`);
    return parseEcbDaily(await res.text());
  }
  // NBS (RS profile) — adapter not implemented yet; see docs/BACKLOG.md.
  logEvent('fx.source_not_implemented', { level: 'warn', source });
  return null;
}

/** Stores one rate set; returns how many rows were new. */
export async function storeRates(workerPool: Pick<Pool, 'query'>, set: RateSet): Promise<number> {
  let inserted = 0;
  for (const r of set.rates) {
    const { rows } = await workerPool.query<{ ok: boolean }>(
      'SELECT fx_rates_upsert($1, $2, $3, $4::numeric, $5::date) AS ok',
      [set.source, set.base, r.quote, r.rate, set.validOn],
    );
    if (rows[0]?.ok) inserted += 1;
  }
  return inserted;
}

export async function fxRatesJob(deps: FxDeps): Promise<void> {
  const fetcher = deps.fetch ?? (fetch as unknown as Fetcher);
  const { rows } = await deps.appPool.query<{ fx_source: string }>(
    'SELECT DISTINCT fx_source FROM jurisdiction_profiles WHERE fx_source IS NOT NULL ORDER BY 1',
  );
  for (const { fx_source: source } of rows) {
    try {
      const set = await fetchSet(source, fetcher);
      if (!set) continue;
      const inserted = await storeRates(deps.workerPool, set);
      logEvent('fx.rates_stored', { source, validOn: set.validOn, pairs: set.rates.length, inserted });
    } catch (error) {
      logEvent('fx.rates_failed', {
        level: 'error',
        source,
        name: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
