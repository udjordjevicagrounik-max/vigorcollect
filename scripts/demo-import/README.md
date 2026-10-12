# Demo import (task 2.2)

`fakture-demo.csv` — 22 generated invoices of 5 demo companies (tax ids `DEMO-…`, rule 24),
Serbian ERP conventions: `;` separator, decimal comma, `dd.mm.yyyy`. Due dates are relative to the
day the file was generated, so every aging bucket has rows; every fourth invoice is partly paid in
the ERP (open = 40 %), which the import turns into a source settlement.

Regenerate (dates move with today):

    npx tsx scripts/demo-import/generate.ts > scripts/demo-import/fakture-demo.csv

The e2e flow (`tests/e2e/receivables.spec.ts`) generates the file on the fly with `demoCsv()`.
