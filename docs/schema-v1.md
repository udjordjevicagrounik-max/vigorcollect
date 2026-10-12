# Schema v1 — rečnik tabela

Izvor istine je SQL u `db/migrations/` (pravilo 4). Ovaj dokument objašnjava **zašto** tabela
postoji i ko sme šta. Stanje: **0.2b** (`001_identity_tenant_governance`,
`002_customers_subject_keys`). 0.2c dodaje external_parties, access_grants, data_sources,
approval_requests, decisions, export_log, translations, code_lists.

## Zajednička pravila

| Pravilo              | Kako je sprovedeno                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PK                   | `uuid DEFAULT gen_random_uuid()`                                                                                     |
| Vreme                | `created_at`/`updated_at` `timestamptz` (UTC), trigger `set_updated_at()`; datumi bez vremena su `date` (pravilo 26) |
| Akter                | `created_by`/`updated_by uuid` bez FK — akter može biti korisnik, sistem ili job                                     |
| RLS                  | **ENABLE + FORCE na svakoj tabeli** — ni vlasnik `vigor_migrate` ne zaobilazi RLS                                    |
| Tenant kontekst      | `app_tenant_id()` = `nullif(current_setting('app.tenant_id', true), '')::uuid`; bez `SET LOCAL` → NULL → 0 redova    |
| Tenant politika      | `tenant_isolation`: `USING/WITH CHECK (tenant_id = app_tenant_id())`, važi za sve role                               |
| Platformska politika | `app_read` (SELECT za `vigor_app`) + `migrate_all` (održavanje kao `vigor_migrate`)                                  |
| Cross-tenant FK      | kompozitni FK `(tenant_id, x_id) → x(tenant_id, id)` — red ne može da pokazuje na red drugog tenanta                 |
| Prava                | default privilegije daju `vigor_app` DML; migracija `REVOKE`-uje sve što app ne sme                                  |
| PII                  | svaka kolona ima red u `pii_field_registry` (golden test)                                                            |

PII klase: **P0** nije lični podatak · **P1** direktan identifikator (ime, email, telefon) ·
**P2** osetljiv identifikator (JMBG, broj LK, adresa i račun fizičkog lica) · **P3** posebna
kategorija GDPR čl. 9. P1–P3 se šifruju kroz `subject_keys` (ADR 0003): `<polje>_enc` +
`<polje>_key_version`; tačna pretraga kroz `<polje>_bidx` (HMAC ključem tenanta). P1–P3 kolona
bez šifrovanja mora imati `exception_reason` (golden test) — npr. `users.email` = `auth identity`.

## Platformske tabele (bez `tenant_id`; app = samo SELECT)

| Tabela                   | Svrha                                                                                                               | Vlasnik / ko piše                                           | Izvor istine                                               | PII                                                                                                      | Audit implikacije                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `jurisdiction_profiles`  | konfiguracija po zemlji (valuta, locale, zona, FX izvor). = `country_profiles` iz pravila 17 (ADR 0002)             | platforma (`vigor_migrate`, admin alat platforme)           | ova tabela; pravni parametri se dodaju aditivno po sprintu | P0                                                                                                       | promena = platformska akcija → `audit_log` pod tenantom #0                                                                               |
| `exchange_rates`         | kursevi; `valid_on date` = lokalni datum izvora                                                                     | samo `fxRatesJob` (pravilo 18), nikad app                   | izvor (ECB/NBS/…)                                          | P0                                                                                                       | job upisuje `domain_event`; kurs se ne prepisuje (zamrzava se na dokumentu)                                                              |
| `pii_field_registry`     | PII klasa svake kolone (+ `conditional_on`/`conditional_pii_class`)                                                 | migracije                                                   | ova tabela; golden test proverava pokrivenost              | P0                                                                                                       | menja se samo migracijom (pregled pravilo 13)                                                                                            |
| `permissions`            | katalog `objekat.akcija`                                                                                            | migracije                                                   | `docs/permissions.md`                                      | P0                                                                                                       | nova permisija = izmena matrice + odobrenje (pravilo 7)                                                                                  |
| `platform_feature_flags` | platformski nivo flagova (kill switch); seed: 7 × `settlement.*` = off                                              | platforma                                                   | ova tabela                                                 | P0                                                                                                       | promena → `audit_log` + `domain_event` pod tenantom #0 (pravilo 31)                                                                      |
| `legal_entities`         | **kanonski identitet** pravnog lica; isto lice kod više tenanta = jedan red (pravilo 30). Bez finansijskih podataka | platformski servis; od 0.2b `find_or_create_legal_entity()` | ova tabela + verifikacioni izvori                          | P0; kad je lice fizičko (`customers.is_natural_person`) → naziv P1, tax_id/registration_number/adresa P2 | app vidi **samo** entitete povezane sa svojim tenantom (`tenant_companies`, od 0.2b i `customers`); bez konteksta ništa (pravila 30, 33) |

## Tenant tabele (`tenant_id NOT NULL`, `tenant_isolation`)

| Tabela             | Svrha                                                                                                                                                            | Ko piše (vigor_app)                                            | Izvor istine                                                     | PII                                  | Audit implikacije                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `tenants`          | tenant; `is_platform_operator` = tenant #0 (najviše jedan)                                                                                                       | **niko** iz app-a (SELECT svog reda); provisioning = platforma | ova tabela                                                       | P0                                   | provisioning/suspenzija → `audit_log` pod tenantom #0                  |
| `tenant_settings`  | jezik (default `en`), zona (poslovni dan), valuta, zemlja tenanta                                                                                                | UPDATE (tenant admin); INSERT/DELETE samo platforma            | ova tabela                                                       | P0                                   | svaka izmena → `audit()` (before/after)                                |
| `tenant_companies` | tenantove sopstvene kompanije → `legal_entity_id`                                                                                                                | INSERT/UPDATE; bez DELETE (status)                             | ova tabela + `legal_entities`                                    | P0; P1 ako je kompanija fizičko lice | `audit()`; deaktivacija kroz `status`                                  |
| `users`            | članstvo osobe u tenantu; `auth_user_id` = most ka Better Auth (`auth` šema, 1.3)                                                                                | INSERT/UPDATE; bez DELETE (status)                             | Better Auth za kredencijale; ova tabela za članstvo, jezik, zonu | email P1, display_name P1            | `audit()` za poziv, aktivaciju, deaktivaciju                           |
| `roles`            | uloge tenanta (`key`; naziv kroz `translations`, 0.2b)                                                                                                           | DML                                                            | ova tabela                                                       | P0                                   | `audit()`                                                              |
| `role_permissions` | uloga → permisija (kompozitni FK na `roles`)                                                                                                                     | DML                                                            | ova tabela + `permissions`                                       | P0                                   | `audit()`; za admin role maker-checker od 1.4 (ADR 0002, odluka 2)     |
| `user_roles`       | korisnik → uloga + `scope` (`OWN`/`TEAM`/`ORGANIZATION`, default `OWN`; `TEAM` = `OWN` do 1.4)                                                                   | DML                                                            | ova tabela                                                       | P0                                   | `audit()`; za admin role maker-checker od 1.4 (ADR 0002, odluka 2)     |
| `feature_flags`    | tenant nivo flagova; efektivno = platforma **AND** tenant. Trigger odbija `enabled` dok je platformski off; settlement traži pravni osnov + jurisdikciju (CHECK) | INSERT/UPDATE; bez DELETE                                      | ova tabela                                                       | P0                                   | uključivanje/isključivanje → `audit_log` + `domain_event` (pravilo 31) |

| `customers` | **TenantPartyRelationship** (pravilo 30): `legal_entity_id` + tip veze + tenantovi atributi (vlasnik, status, kreditni status, jezik, segment, `external_id`) | INSERT/UPDATE; bez DELETE (status) | ova tabela; identitet u `legal_entities` | `display_name` P0 / fizičko lice: samo `display_name_enc` (P1, CHECK) | `audit()`; blokada i kreditni limit kroz maker-checker (pravilo 11); fizičko lice → `decisions` (pravilo 19) |
| `customer_contacts` | osobe kod kupca; ime, email, telefon **samo šifrovano**; `email_bidx` za tačnu pretragu | INSERT/UPDATE; bez DELETE (brisanje = crypto-shredding) | ova tabela | P1 šifrovano; `email_bidx` P1 (HMAC po tenantu) | `audit()` bez PII u snapshot-u (samo id-jevi) |
| `subject_keys` | ključ podataka po subjektu + blind index ključ tenanta, šifrovani master ključem (ADR 0003) | INSERT/SELECT; rotacija i uništavanje = poseban job | ova tabela + `PII_MASTER_KEYS` (okruženje) | P0 (ključni materijal, ne PII) | uništavanje ključa = brisanje subjekta → `audit_log` |

## Governance

| Tabela          | Svrha                                                                            | Ko piše (vigor_app)                                                                                             | PII                                                 | Napomena                                                                             |
| --------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `audit_log`     | nepromenljiv trag svake mutacije (pravilo 6); platformske akcije pod tenantom #0 | **samo INSERT** (+ SELECT svog tenanta). UPDATE/DELETE/TRUNCATE: nema prava, nema RLS politike, trigger blokira | `before`/`after` = P2 (mogu nositi bilo koje polje) | samo `created_at` (red se ne menja); `request_id` = `X-Request-Id` (pravilo 23)      |
| `domain_events` | outbox za pg-boss (pravilo 30: istorija događaja je strateška)                   | INSERT + SELECT; status menja **worker rola** (`vigor_worker`, 1.5)                                             | `payload` P2, `last_error` P1                       | `status` pending → processing → processed/failed; `processed_at` ⇔ processed (CHECK) |

## Indeksi i ograničenja vredna pažnje

- `legal_entities UNIQUE (country_code, tax_id)` — identitet pravnog lica (pravilo 25: generički identifikatori).
- `tenants_single_platform_operator` — tačno jedan tenant #0.
- `tenant_companies_single_default` — najviše jedna podrazumevana kompanija po tenantu.
- `users UNIQUE (tenant_id, email)` (citext) i `UNIQUE (tenant_id, auth_user_id)` — ista osoba može biti član više tenanta (po jedan red).
- `domain_events_pending` — parcijalni indeks za dispatcher.
- `customers UNIQUE (tenant_id, legal_entity_id)` — jedno pravno lice je jednom u portfoliju tenanta (`relationship_type = both` za kupca i dobavljača).
- `customers_name_protection` — fizičko lice nikad nema čist `display_name`.
- `subject_keys_single_active` — tačno jedan aktivan ključ po subjektu i svrsi; `subject_keys_purpose_subject` — blind index ključ pripada samo tenantu.
- `find_or_create_legal_entity()` — jedini put upisa u `legal_entities` iz app-a: SECURITY DEFINER, `search_path=''`, traži tenant kontekst, tačno `(country_code, tax_id)`, vraća samo `id`, ne menja postojeći red.
- `app_read_linked` na `legal_entities` — vidljivo samo preko sopstvenih `tenant_companies` **ili** `customers`.
