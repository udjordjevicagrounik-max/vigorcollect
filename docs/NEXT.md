# NEXT

## Aktivan zadatak

**0.2c Schema v1 — deljenje i governance** (migracija `003_*`): `external_parties` i
`access_grants` (pravilo 34), `data_sources` (prava iz pravila 35), `approval_requests`,
`decisions` (pravilo 19), `export_log`, `translations`, `code_lists`.

Uslov za početak: Uroš je commit-ovao `db/migrations/002_*`, generisao `PII_MASTER_KEYS` u
`.env`, primenio 002 na `collect` i pokrenuo seed (komande u izveštaju 0.2b / runbook).

Obavezno u 0.2c:

- `access_grants` je jedini put do pojedinačnog resursa, i to samo za spoljne strane (ADR 0002,
  odluka 1); grant je vremenski ograničen, opoziv, vezan za svrhu i auditiran.
- `code_lists` + FK sa `customers.segment_code` (aditivno).
- `translations` za nazive uloga (`roles.key`) i tenantove code liste (pravilo 17).
- Svaka nova tabela: ENABLE + FORCE + politika, kompozitni FK, PII red za svaku kolonu; P1+
  bez šifrovanja samo uz `exception_reason` (golden test).
- Odgovor na otvoreno pitanje „fizičko lice u `legal_entities`" (ispod) pre bilo kog uvoza kupaca.

## Poslednja sesija — 0.2b stranke i šifrovanje (2026-10-12)

### Urađeno

- **Migracija 002 (predlog, NIJE commit-ovana, NIJE primenjena na `collect`):**
  `db/migrations/002_customers_subject_keys_{up,down}.sql`:
  - `subject_keys` (ključ podataka po subjektu + blind index ključ tenanta, šifrovani master
    ključem; jedan aktivan po subjektu/svrsi; app samo INSERT/SELECT);
  - `customers` (TenantPartyRelationship, `is_natural_person`, `owner_user_id`; fizičko lice →
    ime samo šifrovano, CHECK);
  - `customer_contacts` (ime, email, telefon samo šifrovani + `*_key_version`; `email_bidx`);
  - `user_roles.scope` (`OWN`/`TEAM`/`ORGANIZATION`, default `OWN`);
  - `find_or_create_legal_entity()` (SECURITY DEFINER, `search_path=''`, tenant kontekst,
    tačno poklapanje, vraća samo `id`, ne menja postojeći red; EXECUTE samo `vigor_app`);
  - `app_read_linked` proširena na `customers` (`ALTER POLICY`);
  - `pii_field_registry.exception_reason`; `users.email`/`display_name` = `auth identity`.
  - Na `collect_test`: up → down → up bez greške.
- **`src/server/crypto`**: keyring (`PII_MASTER_KEYS`, verzije), AES-256-GCM envelope sa AAD
  (tenant, tabela.kolona, red, verzija), blind index (HMAC ključem tenanta), `subject_keys`
  (kreiranje, unwrap, tenant iz `app_tenant_id()`). Samo `node:crypto`, bez novih paketa.
- **`src/server/customers/repository.ts`**: `createCustomer` (kroz `find_or_create_legal_entity`),
  `readCustomerName`, `createContact`, `findContactIdsByEmail` (tačno, nikad ne kreira ključ),
  `readContact`. Zod validacija ulaza.
- **Testovi**: unit `tests/unit/crypto.test.ts` (7); golden DB 70 (bilo 39): `customers`,
  `find-or-create-legal-entity`, `encryption` (nema čistog teksta u redu, AAD, blind index A ≠ B,
  pretraga samo u svom tenantu), registar (P1+ ⇒ `encrypted` ili `exception_reason`; svaka
  `*_enc` ima `*_key_version`). Mutacioni test: 5 pokvarenih zaštita → 7 testova pada.
- **Seed**: admin uloga `scope = ORGANIZATION` + audit `user_role.assigned`; demo tenant dobija
  2 kupca (kompanije) sa po jednim šifrovanim primarnim kontaktom; bez `PII_MASTER_KEYS` staje
  pre prvog upisa. Proveren 2× na `collect_test`, test baza vraćena na fixture stanje.
- **Docs**: ADR 0003 (šifrovanje, `key_version`, rotacija, master ključ van backup-a), runbook
  „PII master ključ", `schema-v1.md`, `.env.example`, ADR 0002 „Odluke posle 0.2a".

### Nije urađeno

- Commit i primena migracije 002 na `collect` — čeka Urošev `!` (pravilo 13).
- `docker-compose.yml` (zaštićen): app servisu dodati `PII_MASTER_KEYS: ${PII_MASTER_KEYS:?}` pre
  prve rute koja čita kontakte (1.x). Danas ga koriste samo seed i testovi.
- Re-wrap / re-encrypt job i erasure (crypto-shredding) tok — ADR 0003, BACKLOG.
- `audit()` / `requirePermission` oko repozitorijuma — servisi u 1.x (repozitorijum je sloj ispod).

### Pretpostavke (najkonzervativnija opcija, bez DROP/RENAME rizika)

1. `customers.legal_entity_id` je `NOT NULL` — svaki kupac ima kanonski identitet (pravilo 30).
2. `customers.language` je NULL = nasleđuje `tenant_settings.default_locale` (tri nivoa jezika).
3. `credit_status` default `unrated` (`green`/`yellow`/`red`); `status` `active`/`inactive`/`blocked`.
4. `segment_code` je tekst bez FK; FK na `code_lists` dolazi aditivno u 0.2c.
5. `customers` nema `tenant_company_id` („kompanija koja vodi kupca", pravilo 26) — aditivno kad zatreba.
6. Kontakt: ime obavezno, email/telefon opciono, najviše jedan primarni po kupcu, bez DELETE.
7. Blind index samo za email kontakta; telefon nema indeks (pretraga po telefonu nije tražena).
8. Šifrovanje u aplikaciji (`node:crypto`), ne `pgcrypto` — ključ nikad ne prolazi kroz SQL (ADR 0003).
9. `audit_log.before/after` i `domain_events.payload` smeju da nose samo id-jeve, P0 ili šifrat; `last_error` samo kodove.
10. `find_or_create_legal_entity`: `tax_id` sa razmakom na krajevima se odbija (22023), ne „popravlja"; prvi upis određuje `legal_name`.
11. Repozitorijum čita tenant iz sesije (`app_tenant_id()`), nikad iz parametra (pravilo 2).
12. Seed pravi samo kupce-kompanije; dev seed podiže postojeći `OWN` admin na `ORGANIZATION`.

### Otvoreno pitanje (pravilo 15 — pogrešan izbor bi kasnije tražio izmenu šeme)

**Fizičko lice u `legal_entities`.** `legal_entities` je globalna tabela sa čistim tekstom. Za
fizičko lice bi `legal_name`, `tax_id` (npr. JMBG) i adresa bili P1/P2 u čistom tekstu, vidljivi
svakom tenantu koji ga ima u portfoliju. Ne mogu se šifrovati ključem tenanta, jer je red
zajednički. Predlog: (a) **preduzetnik** (registrovan, javni registar) ide u `legal_entities`
kao danas, uz `exception_reason`; (b) **potrošač** (bez registracije) NE ide u `legal_entities`
— `customers.legal_entity_id` postaje nullable za `is_natural_person`, a identitet se čuva
šifrovano na `customers` (nove kolone, aditivno). Do odluke seed i testovi ne prave potrošače.

### Odluke Uroša posle 0.2a (2026-10-12; ADR 0002)

1. **Resource-scoped permisije:** kolona `scope` na `user_roles` (`OWN` / `TEAM` / `ORGANIZATION`),
   bez nove tabele. Pristup pojedinačnom resursu postoji samo kroz `access_grants`, i to samo za
   spoljne strane.
2. **Maker-checker:** izmene `role_permissions` i `user_roles` za admin role idu kroz
   maker-checker. Implementacija u 1.4 kroz `approval_requests`; u 0.2b samo `audit()`.
3. **`legal_entities.tax_id NOT NULL` ostaje**; fizička lica bez PIB-a → BACKLOG.

## Rizik

- **`PII_MASTER_KEYS` gubitak = trajni gubitak svih P1–P3 podataka.** Dev ključ je samo u
  `.env`; staging/prod ključevi u vault-u, dve kopije, nikad u backup-u (ADR 0003, runbook).
- **Dev kontejner postavlja `PIP_TARGET=/opt/app/data/.python-deps` i `PYTHONPATH` na isto.**
  Svaka `pip install` bez očišćenog okruženja piše u `/opt/app/data/`. Tako je nastao i
  zalutali direktorijum u 0.1; Uroš ga je obrisao 2026-10-11. `setup-tools.sh` instalira
  semgrep kroz pipx sa očišćenim pip okruženjem.
- **Pre-commit sada zahteva bazu** (`test:db`): bez `docker compose up -d db` commit ne prolazi
  (namerno; poruka upućuje na runbook).
- **`test:db` primenjuje i necommit-ovane migracije na `collect_test`.** Ako se predlog migracije
  menja posle primene, checksum pada → reset test baze (`down` pa `up`, runbook).
- **Docker daemon ≠ ovaj kontejner.** Bind mount-ovi iz `/srv/vigor-collect` ne rade; sve što ide
  u kontejner mora kroz build context. Portovi: `DB_BIND_HOST=172.17.0.1`, `POSTGRES_PORT=15432`.
- Login (1.3) i outbox dispatcher (1.5) ne mogu da rade dok se ne urade pravci iz ADR 0002 „Otvoreno".
- Statički golden test je regex nad SQL-om; živa provera je `tests/golden/db/rls.test.ts`.
- `npm audit` u hook-u zavisi od mreže — offline commit neće proći.

## Istorija

- **0.2b stranke i šifrovanje** (2026-10-12): commit ove sesije (testovi, kod, docs); migracija
  002 čeka Uroša.

- **0.2a Schema v1** (2026-10-11/12): `4bf31ef` testovi, seed, docs; `82b5905` migracija 001 (Uroš).
  18 pretpostavki iz noćnog režima: `git show 4bf31ef:docs/NEXT.md`.
  Na `collect`: `schema_migrations` = 000, 001; seed: 2 legal entities, po 1 tenant/user po
  kontekstu, audit tenant #0 = 3 reda (1 user.created + 2 tenant.provisioned), demo = 1.
- **0.1 Bootstrap** (2026-10-11): `bcde887` skelet, `335a261` zaštićeni fajlovi (Uroš). Detalji u ADR 0001.
