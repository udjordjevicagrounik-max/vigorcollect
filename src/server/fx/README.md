# src/server/fx

`Money` helper (amount + currency + rounding, never float — rule 18) and `fxRatesJob`
(sources per jurisdiction profile; ECB default, EUR base pair — rule 25). Rates are read only
from `exchange_rates`; `valid_on` is a `date` (rule 26). Not started.
