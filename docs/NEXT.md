# NEXT

## Aktivan zadatak

**0.2b Schema v1 — stranke, deljenje, odluke** (migracija `002_*`): customers, customer_contacts,
external_parties, access_grants, approval_requests, decisions, export_log, translations,
code_lists, subject_keys, data_sources.

Uslov za početak: Uroš je commit-ovao `db/migrations/001_*` i primenio 001 na dev bazu `collect`.

Obavezno u 0.2b:

- **`legal_entities` upis ide isključivo kroz `SECURITY DEFINER` funkciju
  `find_or_create_legal_entity(country_code, tax_id, …)`** koja vraća **samo `id`** po
  **tačnom** poklapanju `(country_code, tax_id)` — nikad listu, nikad `LIKE`/fuzzy, nikad
  ostale kolone. Funkcija ima `SET search_path`, `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE`
  samo `vigor_app`, i zahteva tenant kontekst (`app_tenant_id() IS NOT NULL`).
- Proširiti `legal_entities` politiku `app_read_linked` na `customers` (izmena RLS politike →
  potpis, pravilo 13).
- `subject_keys` + šifrovanje P1–P3 (`users.email`, `users.display_name`, uslovno
  `legal_entities`) + **blind index** za pretragu/login po email-u; `encrypted=true` u registru.
- `customers.is_natural_person` — na nju se već pozivaju `pii_field_registry.conditional_on` redovi.
- Svaka nova tabela: ENABLE + FORCE + politika, kompozitni FK, PII red za svaku kolonu
  (golden testovi to već proveravaju — padaju ako se zaboravi).

## Poslednja sesija — 0.2a Schema v1: identitet, tenant, governance (2026-10-11, noćni režim)

### Urađeno

- **Migracija 001 (predlog, NIJE commit-ovana, NIJE primenjena na `collect`):**
  `db/migrations/001_identity_tenant_governance_{up,down}.sql` — 16 tabela (15 iz plana
  (+ `platform_feature_flags`), funkcije `app_tenant_id()`, `set_updated_at()`,
  `feature_flags_require_platform()`, `audit_log_block_mutation()`; ENABLE + FORCE RLS na svakoj
  tabeli; kompozitni FK; `REVOKE` po tabeli; seed 7 × `settlement.*` = off; 175 redova u
  `pii_field_registry` (svaka kolona). Na `collect_test`: up → down → up bez greške.
- **Test baza `collect_test`**: `scripts/setup-test-db.sh` (poziva ga `setup-tools.sh`),
  idempotentno, ista prava kao dev baza. `scripts/lib/env.sh` izvodi `TEST_*` URL-ove.
- **`npm run test:db`** (`scripts/test-db.sh`): `pg_isready` → jasna poruka „pokreni db (runbook
  korak 2)" bez stack trace-a → migracije na test bazu → Vitest (`vitest.db.config.ts`).
  Dodat u pre-commit kao korak `8_test_db`.
- **Golden testovi**: statički `rls-coverage` sada traži ENABLE + FORCE + politiku za **svaku**
  tabelu (izuzetak: ledger iz 000). Na živoj bazi (39 testova): pg_class provera RLS/FORCE/politika,
  0 redova bez tenant konteksta (app i vlasnik), A ne vidi B, WITH CHECK, kompozitni FK,
  `legal_entity_id` bez konteksta ne otkriva ništa, app ne piše platformske tabele, audit_log
  (prava, RLS, trigger za UPDATE/DELETE/TRUNCATE), flagovi (trigger + CHECK), PII registar
  (svaka kolona, bez viška). Mutacioni test: 5 namerno pokvarenih zaštita → 5 testova pada.
- **`scripts/seed-demo.ts`**: tenant #0 Sinergista + demo tenant, po 1 legal entity, company,
  user, rola, dodela; audit (provisioning pod tenantom #0); idempotentno, kao `vigor_migrate`
  sa `SET LOCAL app.tenant_id`. Provereno na `collect_test` (2× pokretanje, bez duplikata), pa
  vraćeno na fixture-only stanje.
- **Docs**: `docs/schema-v1.md`, `docs/adr/0002-canonical-party-model.md` (odluke, pravilo 38,
  „Otvoreno": login → `auth` šema, outbox → `vigor_worker`), runbook (`!` komande, test baza),
  README, `.env.example`.

### Nije urađeno

- Commit i primena migracije 001 na `collect` — čeka Urošev `!` (pravilo 13).
- Seed na dev bazi — posle primene 001: `! cd /srv/vigor-collect && npm run seed`.
- Drizzle definicije u `src/db/schema` za tabele iz 001 (BACKLOG — potrebne pre prvog ekrana sa podacima).
- `verify-tenant.sh` / `rls-drift-check.sh` DB provere → 1.6 (golden DB testovi već pokrivaju veći deo).

### Pretpostavke za Uroša (najkonzervativnija opcija, bez DROP/RENAME rizika)

1. `jurisdiction_profiles` ima samo identitetske kolone (zemlja, valuta, locale, zona, `fx_source`); pravni parametri (kamata, naknada, zastarelost) dodaju se aditivno u sprintu koji ih koristi.
2. `legal_entities.tax_id` je `NOT NULL` (zbog `UNIQUE(country_code, tax_id)`); fizičko lice bez poreskog broja bi tražilo `DROP NOT NULL` (nije DROP kolone).
3. `legal_entities` nema `is_natural_person`; flag ostaje na `customers` (pravilo 19), a `conditional_on = 'customers.is_natural_person = true'`.
4. Uz `conditional_on` dodata je i `conditional_pii_class` (klasa kad uslov važi — P1 ili P2 se razlikuju po koloni).
5. Uslovno su klasifikovani i `tax_id` (P2), `normalized_name` (P1) i sva adresna polja (P2), ne samo tri navedene kolone; `tenant_companies.display_name` P0 → P1.
6. `audit_log.before/after` i `domain_events.payload` su P2, `domain_events.last_error` P1 (mogu nositi bilo koje polje).
7. `tenants` je za app samo SELECT (preimenovanje tenanta = platformska akcija).
8. `tenant_settings`: app sme samo UPDATE; INSERT/DELETE samo pri provisioningu.
9. `users` i `tenant_companies` se ne brišu iz app-a (bez DELETE) — deaktivacija kroz `status`.
10. `domain_events`: app samo INSERT + SELECT; status menja worker (1.5).
11. `audit_log` nema `updated_at`/`updated_by` (redovi su nepromenljivi).
12. `created_by`/`updated_by` su uuid bez FK (akter može biti sistem/job).
13. Ista osoba u više tenanta = više `users` redova povezanih preko `auth_user_id`.
14. Nazivi uloga idu kroz `translations` (0.2b) po `roles.key`; `roles` nema kolonu sa nazivom.
15. Settlement flag sme biti `enabled` samo uz `legal_basis_confirmed_at` + `jurisdiction_country_code` (CHECK); ostali flagovi samo uz `enabled_by`/`enabled_at`.
16. Seed: Sinergista i demo tenant u RS (`Europe/Belgrade`, RSD); tenant #0 `sr-Latn`, demo `en`; lažni identifikatori `DEMO-…`, email na rezervisanom `.example` TLD-u.
17. 001 registruje i kolone `schema_migrations` (P0) u `pii_field_registry` — 000 nije menjana.
18. `001_down` briše i `citext` ekstenziju (up je kreira; ranije nije postojala).

### Otvorena pitanja

1. **Resource-scoped permisije** (pravilo 30 kao preduslov šeme v1): nullable `tenant_company_id`
   na `user_roles` ili zasebna tabela opsega? Oba su aditivna — namerno nije urađeno u 0.2a.
2. Da li `role_permissions` izmene treba da idu kroz maker-checker (`approval_requests`, 0.2b)?

## Rizik

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

- **0.1 Bootstrap** (2026-10-11): `bcde887` skelet, `335a261` zaštićeni fajlovi (Uroš). Detalji u ADR 0001.
