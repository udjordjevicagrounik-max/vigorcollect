# APR — Agencija za privredne registre (RiskProvider, RS)

|                            |                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provajder**              | APR, javni registar privrednih subjekata (Srbija). Dostupan samo za zemlje gde ga `jurisdiction_profiles.risk_providers` navodi (RS) — pravilo 25. |
| **Autentifikacija**        | —                                                                                                                                                  |
| **Env**                    | —                                                                                                                                                  |
| **Prava (`data_sources`)** | prikaz da, skladištenje da (365 dana), izvedeni da, redistribucija ne (konzervativno, do pravne provere).                                          |
| **Stanje**                 | **stub: `unsupported / no_public_api`.**                                                                                                           |

## Šta je poznato

- Pretraga privrednih subjekata (status, podaci o subjektu) i objavljeni finansijski izveštaji su
  dostupni kroz **web pretragu** APR-a, ne kroz dokumentovan javni API.
- Postoje skupovi otvorenih podataka koji se objavljuju periodično (masovni fajlovi), i plaćeni
  servisi za pravna lica — uslovi i format nisu utvrđeni za ovaj projekat.
- Ne radimo scraping web forme (uslovi korišćenja, stabilnost, pravilo 35).

## Sledeći korak

Odluka: (a) ugovoreni servis APR-a, ili (b) periodični uvoz otvorenih podataka kao fajl
(`imports`, ERP CSV obrazac) → signali `status` / blokada. Do tada ocena nema APR signal.

## Retry, keš, test, troubleshooting

Isto kao [checkpoint.md](checkpoint.md); u dnevniku sinhronizacije: `unsupported / no_public_api`.
