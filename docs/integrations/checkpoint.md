# CheckPoint (RiskProvider)

|                                        |                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Provajder**                          | CheckPoint — poslovne informacije i kreditni rizik (RS). Probni ključ.                                                                                                                                                                                 |
| **Autentifikacija**                    | API ključ iz okruženja: `CHECKPOINT_API_KEY`. Upisuje ga Uroš (Elestio env panel / `.env` na dev-u) — nikad kroz chat, repo ni log.                                                                                                                    |
| **Env**                                | `CHECKPOINT_API_KEY` (app i worker; `docker-compose.yml` ga prosleđuje oba servisa).                                                                                                                                                                   |
| **Prava (`data_sources`, pravilo 35)** | prikaz **da**, skladištenje **da** (retencija 365 dana — pretpostavka do ugovora), izvedeni podaci da, **redistribucija NE**, onward-sharing ne. Signal iz CheckPoint-a se ne prikazuje trećoj strani (ni kroz `access_grants`).                       |
| **Stanje**                             | **stub.** Bez ključa: `unavailable / not_configured`. Sa ključem: `unsupported / api_not_documented` — API referenca (base URL, endpoint po PIB-u / matičnom broju, format odgovora, limiti) još nije dostavljena, pa adapter **ne pogađa** endpointe. |

## Šta treba da bi adapter radio

1. API dokumentacija: base URL, autentifikacija (header?), endpoint za firmu po PIB-u ili
   matičnom broju, polja za blokadu računa / prinudnu naplatu / status, kodovi grešaka, limit poziva.
2. Uslovi probnog ključa: koliko dugo smemo čuvati odgovor (retencija), da li smemo izvoditi
   ocenu (`may_derive`).
3. Tada: `src/server/risk/providers/checkpoint.ts` mapira odgovor na signal `external_blocked`
   (0/1) uz `validForSeconds` (keš), bez PII u logu; golden test sa snimljenim (izmišljenim)
   odgovorom.

## Endpointi / mapiranje

Nepoznato (vidi gore). Signal koji ocena koristi: `external_blocked` (0 = nema blokade,
1 = blokada / prinudna naplata), ponder `external_blocked` u `tenant_settings.risk_weights`.

## Retry, keš, test

- Timeout 8 s, jedan ponovni pokušaj za `unavailable` (osim `not_configured`); svaki poziv je
  red u `sync_runs` (Administracija → Integracije → Dnevnik sinhronizacije).
- Keš: signal važi do `valid_until`; dnevni posao ne pita ponovo dok signal važi.
- Test: `tests/golden/db/risk.test.ts` (stub → `sync_runs`, keš, prava skladištenja).

## Troubleshooting

| Simptom                              | Uzrok                                                            |
| ------------------------------------ | ---------------------------------------------------------------- |
| `failed / not_configured` u dnevniku | `CHECKPOINT_API_KEY` nije postavljen u okruženju worker-a/app-a. |
| `unsupported / api_not_documented`   | ključ postoji, adapter čeka API specifikaciju.                   |
