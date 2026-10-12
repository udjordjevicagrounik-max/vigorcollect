# src/server/fx

- `money.ts` — `Money` (bigint minor units + currency), strict decimal-string parsing, half-even
  conversion with a frozen rate, `Intl` display from the decimal string. Never a float (rule 18):
  semgrep `no-float-amounts` + `tests/golden/no-float-amounts.test.ts`.
- `rates-job.ts` — `fxRatesJob` (worker queue `fx-rates`, working days 16:30 UTC). Sources from
  `jurisdiction_profiles.fx_source`: ECB implemented (base EUR), NBS skeleton (logs only).
  Writes only through `fx_rates_upsert()`; an existing (source, pair, valid_on) row is never
  rewritten. `valid_on` is a `date` (rule 26).

Documents (invoices, payments) freeze `fx_rate`, `fx_rate_date`, `fx_source` once set — the
database refuses a rewrite (migration 012).
