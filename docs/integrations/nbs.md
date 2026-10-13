# NBS — prinudna naplata / blokade računa (RiskProvider, RS)

|                            |                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Provajder**              | Narodna banka Srbije, podaci o prinudnoj naplati (blokirani računi). Samo RS (`jurisdiction_profiles.risk_providers`). |
| **Autentifikacija**        | —                                                                                                                      |
| **Env**                    | —                                                                                                                      |
| **Prava (`data_sources`)** | prikaz da, skladištenje da (365 dana), izvedeni da, redistribucija ne.                                                 |
| **Stanje**                 | **stub: `unsupported / no_public_api`.**                                                                               |

## Šta je poznato

- Javni uvid u prinudnu naplatu je **interaktivna web pretraga** (po PIB-u / matičnom broju).
- NBS nudi web servise registrovanim korisnicima; pristup i uslovi nisu obezbeđeni za ovaj
  projekat. Nema dokumentovanog javnog API-ja koji bismo smeli da zovemo automatski.
- FX kursevi NBS-a su druga stvar (`fxRatesJob`, pravilo 18) i ne idu kroz ovaj adapter.

## Sledeći korak

Registracija za NBS web servis (ako je dostupna pravnim licima) → adapter mapira „blokada da/ne"
na signal `external_blocked`; do tada ocena nema NBS signal.

## Retry, keš, test, troubleshooting

Isto kao [checkpoint.md](checkpoint.md); u dnevniku sinhronizacije: `unsupported / no_public_api`.
