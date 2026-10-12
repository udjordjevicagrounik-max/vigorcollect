# Matrica permisija

Izvor istine za `requirePermission('objekat.akcija')` (pravilo 7) i za katalog `permissions`
(migracija 004). Golden test `tests/golden/db/permissions-catalog.test.ts` parsira ovu tabelu:
svaki ključ iz tabele mora postojati u bazi i obrnuto. Nova permisija se dodaje ovde **i** u novu
migraciju, uz odobrenje — ne izmišlja se u kodu.

Legenda: ✅ dozvoljeno · ➖ nije dozvoljeno · 🅼 dozvoljeno samo kao checker u maker-checker toku
(pravilo 11; DB CHECK: odobrilac ≠ podnosilac).

## Role

Sistemske role (`roles.is_system = true`) postoje u svakom tenantu; seed ih pravi sa ovim
permisijama. Obim podataka određuje `user_roles.scope` (`OWN` / `TEAM` / `ORGANIZATION`;
`TEAM` = `OWN` do 1.4), ne rola.

| rola                 | namena                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `owner`              | vlasnik naloga tenanta; sve, uključujući odluke iz pravila 11                                              |
| `admin`              | administracija (korisnici, role, podešavanja, integracije, uvoz); bez poslovnih odluka i bez PII kontakata |
| `cfo`                | finansijski direktor; odobrava sve kritične akcije, izveštaji, izvoz                                       |
| `finance_manager`    | fakture, uplate, kupci, uvoz; odobrava kreditni limit i blokadu                                            |
| `collection_manager` | vodi tim naplate: case-ovi, dodela, odobrava blokadu i predaju pravnoj                                     |
| `collector`          | radi svoje case-ove: aktivnosti, obećanja, sporovi; samo **predlaže** kritične akcije                      |
| `sales_manager`      | prodaja: kupci i vlasništvo nad kupcem, uvid u naplatu                                                     |
| `sales_rep`          | svoji kupci: kontakti, aktivnosti, obećanja; samo **predlaže**                                             |
| `legal_manager`      | sporovi i pravni postupak; odobrava predaju pravnoj službi                                                 |
| `auditor`            | samo čitanje, uključujući audit log i dnevnik izvoza                                                       |
| `read_only`          | samo čitanje poslovnih podataka, bez audit loga i podešavanja                                              |

**Spoljne strane** (advokat, broker, faktor …) nisu rola: pristup dobijaju isključivo kroz
`access_grants` (pravilo 34) — jedan resurs, svrha, rok, opoziv, četiri oka.

Kritične akcije iz pravila 11 su `approval.*` permisije: daju pravo da se **odluči** o tuđem
zahtevu. Podnošenje zahteva je `approval.create`. `collector` i `sales_rep` nikad nemaju
`approval.write_off`, `approval.credit_limit`, `approval.block_customer`,
`approval.legal_handover` ni `approval.risk_override` (golden test).

Izvoz (`*.export`) ide samo kroz `exportService` koji piše `export_log` (pravilo 12).

## Matrica

| objekat.akcija            | opis                                              | `owner` | `admin` | `cfo` | `finance_manager` | `collection_manager` | `collector` | `sales_manager` | `sales_rep` | `legal_manager` | `auditor` | `read_only` |
| ------------------------- | ------------------------------------------------- | ------- | ------- | ----- | ----------------- | -------------------- | ----------- | --------------- | ----------- | --------------- | --------- | ----------- |
| `tenant.read`             | Profil tenanta (naziv, zemlja, plan)              | ✅      | ✅      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `tenant.manage`           | Izmena profila tenanta i kompanija                | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `user.read`               | Lista korisnika i njihovih rola                   | ✅      | ✅      | ✅    | ✅                | ✅                   | ➖          | ✅              | ➖          | ✅              | ✅        | ➖          |
| `user.create`             | Pozivnica novom korisniku                         | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `user.update`             | Izmena i deaktivacija korisnika                   | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `user.assign`             | Dodela role i scope-a korisniku                   | 🅼       | 🅼       | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `role.read`               | Role i njihove permisije                          | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ✅        | ➖          |
| `role.manage`             | Izmena permisija role (custom role)               | 🅼       | 🅼       | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `customer.read`           | Kupci i Customer 360                              | ✅      | ✅      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `customer.create`         | Novi kupac                                        | ✅      | ➖      | ➖    | ✅                | ✅                   | ➖          | ✅              | ➖          | ➖              | ➖        | ➖          |
| `customer.update`         | Izmena atributa kupca (segment, jezik, status)    | ✅      | ➖      | ✅    | ✅                | ✅                   | ➖          | ✅              | ➖          | ➖              | ➖        | ➖          |
| `customer.assign`         | Promena vlasnika kupca                            | ✅      | ➖      | ✅    | ✅                | ✅                   | ➖          | ✅              | ➖          | ➖              | ➖        | ➖          |
| `customer.export`         | Izvoz liste kupaca (exportService, pravilo 12)    | ✅      | ➖      | ✅    | ✅                | ✅                   | ➖          | ✅              | ➖          | ➖              | ➖        | ➖          |
| `contact.read`            | Kontakti kupca (dešifrovani)                      | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `contact.create`          | Novi kontakt                                      | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `contact.update`          | Izmena kontakta                                   | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `invoice.read`            | Fakture i otvoren saldo                           | ✅      | ✅      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `invoice.create`          | Ručni unos fakture                                | ✅      | ➖      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `invoice.update`          | Izmena fakture (bez iznosa posle knjiženja)       | ✅      | ➖      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `invoice.export`          | Izvoz faktura (exportService)                     | ✅      | ➖      | ✅    | ✅                | ✅                   | ➖          | ➖              | ➖          | ➖              | ✅        | ➖          |
| `payment.read`            | Uplate i povezivanje sa fakturama                 | ✅      | ✅      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `payment.create`          | Ručni unos uplate                                 | ✅      | ➖      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `payment.update`          | Povezivanje uplate sa fakturom                    | ✅      | ➖      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `case.read`               | Case-ovi naplate                                  | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `case.create`             | Otvaranje case-a                                  | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `case.update`             | Faza i napomene case-a                            | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `case.assign`             | Dodela case-a izvršiocu                           | ✅      | ➖      | ➖    | ✅                | ✅                   | ➖          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `promise.read`            | Obećanja plaćanja                                 | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `promise.create`          | Novo obećanje                                     | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ➖              | ➖        | ➖          |
| `promise.update`          | Ispunjeno / prekršeno / otkazano                  | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `activity.read`           | Aktivnosti (pozivi, emailovi, beleške)            | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `activity.create`         | Nova aktivnost / beleška                          | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `dispute.read`            | Sporovi (prigovori na fakturu)                    | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `dispute.create`          | Prijava spora                                     | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `dispute.update`          | Rešavanje spora                                   | ✅      | ➖      | ➖    | ✅                | ✅                   | ➖          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `dispute.assign`          | Dodela spora                                      | ✅      | ➖      | ➖    | ✅                | ✅                   | ➖          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `decision.read`           | Odluke (kreditni status, eskalacija)              | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ➖          | ✅              | ✅        | ➖          |
| `decision.create`         | Predlog odluke                                    | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ➖              | ➖          | ✅              | ➖        | ➖          |
| `decision.approve`        | Odobrenje odluke — ljudski odobrilac (pravilo 19) | 🅼       | ➖      | 🅼     | 🅼                 | 🅼                    | ➖          | ➖              | ➖          | 🅼               | ➖        | ➖          |
| `approval.read`           | Red zahteva za odobrenje                          | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ➖          |
| `approval.create`         | Podnošenje zahteva (maker)                        | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `approval.write_off`      | Odluka o otpisu (checker)                         | 🅼       | ➖      | 🅼     | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `approval.credit_limit`   | Odluka o promeni kreditnog limita (checker)       | 🅼       | ➖      | 🅼     | 🅼                 | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `approval.block_customer` | Odluka o blokadi kupca (checker)                  | 🅼       | ➖      | 🅼     | 🅼                 | 🅼                    | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `approval.legal_handover` | Odluka o predaji pravnoj službi (checker)         | 🅼       | ➖      | 🅼     | ➖                | 🅼                    | ➖          | ➖              | ➖          | 🅼               | ➖        | ➖          |
| `approval.risk_override`  | Odluka o ručnoj promeni rizika (checker)          | 🅼       | ➖      | 🅼     | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `document.read`           | Dokumenti (IOS, opomene, ugovori)                 | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `document.create`         | Generisanje / prilog dokumenta                    | ✅      | ➖      | ➖    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ➖        | ➖          |
| `report.read`             | Izveštaji i dashboard                             | ✅      | ➖      | ✅    | ✅                | ✅                   | ✅          | ✅              | ✅          | ✅              | ✅        | ✅          |
| `report.export`           | Izvoz izveštaja (exportService)                   | ✅      | ➖      | ✅    | ✅                | ✅                   | ➖          | ✅              | ➖          | ✅              | ✅        | ➖          |
| `export.read`             | Dnevnik izvoza (export_log)                       | ✅      | ✅      | ✅    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ✅        | ➖          |
| `import.read`             | Istorija uvoza i greške                           | ✅      | ✅      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `import.create`           | Uvoz fajla (wizard)                               | ✅      | ✅      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `integration.read`        | Integracije (ERP, banka, email)                   | ✅      | ✅      | ➖    | ✅                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `integration.manage`      | Povezivanje i isključivanje integracija           | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `audit.read`              | Audit log tenanta                                 | ✅      | ✅      | ✅    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ✅        | ➖          |
| `audit.export`            | Izvoz audit loga (exportService)                  | ✅      | ➖      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ✅        | ➖          |
| `settings.read`           | Podešavanja tenanta i code liste                  | ✅      | ✅      | ✅    | ✅                | ✅                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `settings.manage`         | Izmena podešavanja i code lista                   | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `feature_flag.read`       | Feature flag-ovi tenanta                          | ✅      | ✅      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |
| `feature_flag.manage`     | Uključivanje flag-a tenanta (pravilo 31)          | 🅼       | ➖      | ➖    | ➖                | ➖                   | ➖          | ➖              | ➖          | ➖              | ➖        | ➖          |

## Javne rute (bez `requirePermission`)

Izuzeci od pravila 7. Svaki izuzetak mora biti ovde, sa razlogom. Ekrani i rute tenanta (sve ostalo) traže punu sesiju (lozinka + TOTP + aktivno članstvo) i `requirePermission` (1.2).

| ruta                                    | metoda    | razlog                                                              | zaštita                                                                                                                                       |
| --------------------------------------- | --------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/health`                               | GET       | liveness/readiness za Docker/Elestio i post-deploy smoke            | samo `status`, `db` i zbirovi poslova (pending, failed, starost, poslednji retention) — nikad podaci (ADR 0005)                               |
| `/manifest.webmanifest`                 | GET       | PWA manifest                                                        | samo `productName` i boje                                                                                                                     |
| `/api/auth/*`                           | GET, POST | Better Auth: prijava, MFA, reset lozinke (pre sesije po definiciji) | rate limit po IP-u, zaključavanje 5 / 15 min, isti odgovor za nepostojeći nalog, bez javne registracije (ADR 0004)                            |
| `/api/invitations/accept`               | POST      | prihvatanje pozivnice (osoba još nema tenant sesiju)                | token 256 bita, jednokratan, 72 h, u bazi samo heš; honeypot; postojeći nalog samo iz verifikovane sesije; odgovor samo kod greške (ADR 0004) |
| `/login`, `/login/mfa`                  | GET       | ekrani prijave (lozinka, TOTP kod)                                  | isti tekst za pogrešnu lozinku, nepostojeći i zaključan nalog; honeypot; rate limit i zaključavanje kroz `/api/auth/*`                        |
| `/invite/[token]`                       | GET       | ekran pozivnice                                                     | iskorišćen, opozvan i nepostojeći token izgledaju isto; podaci samo za važeći token                                                           |
| `/settings/mfa-setup`, `/select-tenant` | GET       | koraci pre tenant sesije (obavezan TOTP, izbor organizacije)        | zahtevaju Better Auth sesiju; bez nje → `/login`; nema podataka tenanta                                                                       |
