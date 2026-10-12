# NEXT

## Aktivan zadatak

**Nema aktivnog zadatka — čeka Uroša:** commit i primena migracije 003 (`!` komanda u izveštaju
0.2c), zatim izbor sledećeg zadatka (Schema v1 je ovim kompletna; sledeći koraci iz sprinta 1:
1.3 login → `auth` šema, 1.4 maker-checker + timovi, 1.5 outbox worker, 1.6 verify/backup).

## Poslednja sesija — 0.2c deljenje i governance (2026-10-12, noćni režim)

### Urađeno

- **Migracija 003 (predlog, NIJE commit-ovana, NIJE primenjena na `collect`):**
  `db/migrations/003_sharing_governance_{up,down}.sql`:
  - potrošač: `customers.legal_entity_id` DROP NOT NULL + CHECK `customers_identity_required`
    (NULL samo za `is_natural_person`); preduzetnik: `exception_reason` na uslovnim redovima
    `legal_entities.*` i `tenant_companies.display_name`;
  - `code_lists` (+ `requires_flag`, pravilo 31) i FK `customers.segment_code` →
    `code_lists` (`customer_segment`) preko generisane kolone `segment_list_key`;
  - `translations` (`role` / `code_list`, po locale-u i polju);
  - `external_parties` (tip iz pravila 34; postojanje ≠ pristup);
  - `access_grants` (jedan resurs po redu, `grant_batch_id`, `permission_keys` provereni u
    `permissions`, rok obavezan, četiri oka, opoziv sa razlogom, opseg zamrznut posle odluke —
    trigger; samo vlasnik tenant vidi grant);
  - `data_sources` (7 prava iz pravila 35, sve najstrože po default-u + 2 CHECK-a);
  - `approval_requests` (maker ≠ checker, sadržaj zamrznut, odluka konačna);
  - `decisions` (pravilo 19: fizičko lice + pravno dejstvo → `approved` samo uz čoveka; rule/AI
    samo predlaže; odobrena odluka može samo `superseded`);
  - `export_log` (INSERT-only: REVOKE + trigger `block_mutation()`; veza na grant);
  - `request_id uuid` na `access_grants`, `approval_requests`, `decisions`, `export_log`.
  - Na `collect_test`: up → down → up bez greške; seed prolazi sa 003.
- **Repozitorijum**: `createConsumer` (nikad `find_or_create`, `legal_entity_id = NULL`, ime
  šifrovano).
- **Testovi**: golden DB 102 (bilo 70): `sharing` (grantovi, data_sources), `governance`
  (maker-checker, pravilo 19, export_log), potrošač + segment FK u `customers`, registar
  (uslovni P1+ ⇒ `encrypted` ili `exception_reason`). Helper `savepointState` za više provera u
  jednoj transakciji. Mutacioni test: 6 pokvarenih zaštita → 9 testova pada.
- **Docs**: ADR 0002 odluka 4, ADR 0003 (pravila rukovanja ključem, slobodne beleške),
  runbook (pravila za ključeve; zamena dev ključa sada `down 003` → `down 002`), `schema-v1.md`.

### Nije urađeno

- Commit i primena migracije 003 na `collect` — čeka Urošev `!` (pravilo 13).
- Iz 0.2b i dalje: `PII_MASTER_KEYS` u `docker-compose.yml` (zaštićen), re-wrap/re-encrypt/erasure
  jobovi, `audit()`/`requirePermission` oko repozitorijuma (1.x).
- Seed bez code lista, prevoda, partnera, grantova i odluka (nije traženo; dodaje se sa prvim
  ekranom koji ih koristi).
- Identitetska polja potrošača osim imena (lični broj, adresa) — BACKLOG, aditivno.

### Pretpostavke (najkonzervativnija opcija, bez DROP/RENAME rizika)

1. `request_id` je `uuid`, ne `text`: isti tip kao `audit_log.request_id`, a `resolveRequestId()` uvek daje UUID; prelaz na `text` bi bio samo ALTER TYPE.
2. `access_grants.resource_type` i `purpose` su kodovi (regex), bez FK — resursi (fakture, case-ovi) još ne postoje; servis proverava postojanje resursa.
3. Status granta je samo `pending`/`active`/`rejected`/`revoked`; „isteklo" se računa iz `valid_until`, ne čuva se.
4. Posle odluke opseg granta je zamrznut; `valid_until` sme samo da se skrati; `rejected`/`revoked` su konačni.
5. Aktivaciju granta odobrava drugi korisnik (četiri oka); opoziv sme svako ovlašćen, i sam autor — opoziv samo smanjuje pristup.
6. Permisije granta moraju postojati u `permissions` (katalog je danas prazan → nijedan grant se ne može napraviti dok se katalog ne popuni — namerno).
7. `data_sources`: `retention_days = 0` znači „ne čuva se posle obrade"; `delete_on_termination` default `true`; onward-sharing traži redistribuciju.
8. `decisions.has_legal_effect` default `true`; pravilo 19 važi za `approved`, a odobrena odluka se samo zamenjuje (`superseded`).
9. Čovek koji predloži odluku ne sme je sam odobriti (četiri oka i za ljudske odluke).
10. `approval_requests`: `cancelled`/`expired` ne traže odlučioca; sadržaj zahteva je zamrznut i dok je `pending`.
11. `export_log.actor_type` uključuje `external_party` (izvoz kroz grant u V2).
12. Slobodni tekst (`decision_note`, `rationale`, `revoke_reason`) je P1 sa `exception_reason` (bez PII, UI napomena) — ne šifruje se jer nema subjekta.
13. `external_parties.display_name` je P0, uslovno P1 za advokata pojedinca (javni registar).
14. `code_lists` se ne brišu (samo `is_active`), `translations` smeju (nema referenci).
15. `external_parties` i `data_sources` su tenant tabele; primalac granta nema pristup bazi do V2 (potvrdio Uroš).

### Odluka Uroša posle 0.2b (2026-10-12; ADR 0002, odluka 4)

**Fizička lica:** preduzetnik (javni registar) ostaje u `legal_entities` uz `exception_reason`.
Potrošač nikad ne ulazi u `legal_entities` i nema `find_or_create`; `customers.legal_entity_id`
postaje nullable uz CHECK (NULL samo za `is_natural_person = true`), a identitet potrošača
postoji samo šifrovano na `customers`. Ulazi u migraciju 003, aditivno.

### Odluke Uroša posle 0.2a (2026-10-12; ADR 0002)

1. **Resource-scoped permisije:** kolona `scope` na `user_roles` (`OWN` / `TEAM` / `ORGANIZATION`),
   bez nove tabele. Pristup pojedinačnom resursu postoji samo kroz `access_grants`, i to samo za
   spoljne strane.
2. **Maker-checker:** izmene `role_permissions` i `user_roles` za admin role idu kroz
   maker-checker. Implementacija u 1.4 kroz `approval_requests`; u 0.2b samo `audit()`.
3. **`legal_entities.tax_id NOT NULL` ostaje**; fizička lica bez PIB-a → BACKLOG.

## Rizik

- **`PII_MASTER_KEYS` gubitak = trajni gubitak svih P1–P3 podataka.** Dev ključ je potrošan
  (samo `.env`); staging/prod ključevi se generišu van Claude sesije i čuvaju u vault-u, nikad u
  backup-u (ADR 0003, runbook).
- **`permissions` katalog je prazan.** Grantovi i `requirePermission` ne mogu da rade dok se
  katalog ne popuni iz `docs/permissions.md` (migracija, 1.x).
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

- **0.2c deljenje i governance** (2026-10-12, noćni režim): commit ove sesije (kod, testovi,
  docs); migracija 003 čeka Uroša.
- **0.2b stranke i šifrovanje** (2026-10-12): `7fd5b9e` kod, testovi, docs; `4fafbe7` migracija
  002 (Uroš). 12 pretpostavki: `git show 7fd5b9e:docs/NEXT.md`. Dev ključ procureo u chat i
  zamenjen istog dana. Na `collect`: migracije 000–002; demo tenant 2 kupca, 2 kontakta, 3 ključa
  (2 subjekta + blind index tenanta), 0 email-ova u čistom tekstu; admin `scope = ORGANIZATION`.

- **0.2a Schema v1** (2026-10-11/12): `4bf31ef` testovi, seed, docs; `82b5905` migracija 001 (Uroš).
  18 pretpostavki iz noćnog režima: `git show 4bf31ef:docs/NEXT.md`.
  Na `collect`: `schema_migrations` = 000, 001; seed: 2 legal entities, po 1 tenant/user po
  kontekstu, audit tenant #0 = 3 reda (1 user.created + 2 tenant.provisioned), demo = 1.
- **0.1 Bootstrap** (2026-10-11): `bcde887` skelet, `335a261` zaštićeni fajlovi (Uroš). Detalji u ADR 0001.
