# NEXT

## Aktivan zadatak

**Sprint 0 zatvoren. Sledeće: 1.1** (obim iz plana sprinta 1 — Uroš potvrđuje pre početka).
Pre toga: commit i primena migracije 004 (`!` komanda u izveštaju 0.3).

## Poslednja sesija — 0.3 permisije i wireframe-i (2026-10-12, noćni režim)

Podela 0.3a (A+B+D) / 0.3b (C) je predložena, ali u noćnom režimu nije čekala potvrdu: oba
dela su urađena u jednoj sesiji, kao dva commit-a.

### Urađeno

- **A. `docs/permissions.md`**: 11 sistemskih rola × 61 permisija (21 objekat). Role imaju
  opis; `external_lawyer` nije rola (pravilo 34). Kritične akcije iz pravila 11 su
  `approval.write_off|credit_limit|block_customer|legal_handover|risk_override` — samo 🅼
  (checker), nikad `collector`/`sales_rep`.
- **B. Migracija 004 (predlog, NIJE commit-ovana)**: `db/migrations/004_permissions_seed_{up,down}.sql`
  — 61 ključ, `ON CONFLICT DO NOTHING`. Parser `src/server/permissions/matrix.ts`; seed pravi
  11 rola u oba tenanta i `role_permissions` iz matrice (audit `role_permission.granted`),
  staje ako katalog nema sve ključeve. Golden testovi: `tests/golden/permissions-matrix.test.ts`
  (oblik matrice, pravilo 11) i `tests/golden/db/permissions-catalog.test.ts` (baza ↔ matrica,
  oba smera). Na `collect_test`: up → down → up; seed 2× (idempotentan, audit 11 po tenantu);
  down posle seed-a zadržava dodeljene ključeve. Mutacioni test: 3 golden testa padaju.
- **C. `docs/wireframes/`**: `dashboard`, `customer-360`, `case` (+ approval modal
  `#predaja`), `import` (wizard u 4 koraka), `admin-users` (+ pozivnica); `?empty=1` na svakom;
  boje samo iz `src/styles/tokens.css`; proveren 375 px i 1280 px (bez horizontalnog skrola).
  Test `tests/unit/wireframes.test.ts` (mobile klasa, tokeni, bez hex-a, linkovi, prazno stanje).
- **D. `docs/BACKLOG.md`**: sekcija „Roadmap" (marketing sajt; self-service sign-up V2) i „Iz 0.3".
- Runbook: zamena dev ključa sada `down 004` → `down 003` → `down 002`.

### Nije urađeno

- Commit i primena 004 na `collect` — čeka Urošev `!` (pravilo 13). Bez 004 seed staje.
- Prevodi naziva rola (`translations`) i en verzija wireframe tekstova — wireframe-i su
  dokumentacija, a stringovi idu u `/messages` sa pravim ekranima.
- `requirePermission` (živi u `src/server/auth/*`, zaštićen) — 1.x.

### Pretpostavke (najkonzervativnija opcija)

1. `approval.<akcija>` = pravo da se **odluči** o tuđem zahtevu (checker); podnošenje je `approval.create` (imaju ga i `collector`/`sales_rep`).
2. Akcije su iz zadatog skupa; jedini izuzetak su 5 `approval.*` ključeva iz pravila 11.
3. Objekat `export` ima samo `export.read` (dnevnik izvoza); sam izvoz je `<objekat>.export` kroz `exportService`.
4. `admin` nema poslovne odluke ni `contact.read` (PII), ali čita kupce/fakture/uplate radi uvoza.
5. `decision.approve` (ljudski odobrilac, pravilo 19) imaju samo `owner`, `cfo`, `finance_manager`, `collection_manager`, `legal_manager` — 🅼.
6. 🅼 i za `user.assign`, `role.manage` (ADR 0002, odluka 2) i `feature_flag.manage` (samo `owner`).
7. Postojeća rola `tenant_admin` (seed 0.2a) postaje `owner` — seed menja ključ (podatak, ne šema) na istom id-ju.
8. Seed samo dodaje grantove; uklanjanje izbačenog granta → BACKLOG.
9. `down 004` ne može da obriše dodeljene ključeve (`role_permissions` je pod RLS-om za `vigor_migrate`): preskače ih uz NOTICE, `up` je no-op.
10. „Demo Agro" i „Test Trgovina" nisu postojali u seed-u → dodati kao 3. i 4. demo kupac (kompanije, šifrovani kontakti).
11. Fakture, case-ovi, obećanja i iznosi u wireframe-ima su mock (tabele još ne postoje); valuta RSD, format sr-Latn.
12. Mobile klase: `dashboard`, `customer-360`, `case` = `mobile-full`; `admin-users` = `mobile-compact`; `import` = `desktop-only`.
13. Faza case-a je code lista `case_stage` (naziv pretpostavljen; tabela `code_lists` postoji od 003).

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

### Za Sprint 1

- **Seed zahteva migraciju 004.** Bez nje `npm run seed` staje sa porukom (namerno).
- **`requirePermission` još ne postoji**, a mora biti na svakoj ruti (pravilo 7). Mesto mu je
  `src/server/auth/*` (zaštićeno) → prvi zadatak sa rutom traži Urošev pregled; parser matrice je
  već u `src/server/permissions/matrix.ts`.
- **Matrica je pretpostavka o poslovnim ulogama** (pretpostavke 1–6). Svaka izmena = izmena
  `docs/permissions.md` + nova migracija; golden test hvata razliku.
- **Wireframe tekst nije kroz `t()`**: pri prelasku u ekrane svi stringovi idu u
  `/messages/sr-Latn.json` + `en.json` (pravilo 17), inače lint `no-literal-strings` pada.
- **Tabele faktura, uplata, case-ova i obećanja ne postoje** — wireframe-i ih pretpostavljaju;
  prva migracija 1.x mora pratiti pravila 15, 18, 26 (`numeric(18,2)` + valuta, `date` za
  dospeće).
- **`PII_MASTER_KEYS` nije u `docker-compose.yml`** (zaštićen) — prva ruta sa kontaktima pada
  u kontejneru dok se ne doda.

### Trajni

- **`PII_MASTER_KEYS` gubitak = trajni gubitak svih P1–P3 podataka.** Dev ključ je potrošan
  (samo `.env`); staging/prod ključevi se generišu van Claude sesije i čuvaju u vault-u, nikad u
  backup-u (ADR 0003, runbook).
- **Dev kontejner postavlja `PIP_TARGET=/opt/app/data/.python-deps` i `PYTHONPATH` na isto.**
  Svaka `pip install` bez očišćenog okruženja piše u `/opt/app/data/` (`setup-tools.sh` instalira
  semgrep kroz pipx sa očišćenim okruženjem).
- **Pre-commit zahteva bazu** (`test:db`): bez `docker compose up -d db` commit ne prolazi.
- **`test:db` primenjuje i necommit-ovane migracije na `collect_test`.** Ako se predlog menja
  posle primene, checksum pada → reset test baze (`down` pa `up`, runbook).
- **Docker daemon ≠ ovaj kontejner.** Bind mount-ovi iz `/srv/vigor-collect` ne rade; portovi:
  `DB_BIND_HOST=172.17.0.1`, `POSTGRES_PORT=15432`.
- Login (1.3) i outbox dispatcher (1.5) ne mogu da rade dok se ne urade pravci iz ADR 0002 „Otvoreno".
- Statički golden test je regex nad SQL-om; živa provera je `tests/golden/db/rls.test.ts`.
- `npm audit` u hook-u zavisi od mreže — offline commit neće proći.

## Istorija

- **0.3 permisije i wireframe-i** (2026-10-12, noćni režim): 0.3a i 0.3b commit-ovi; migracija
  004 čeka Uroša. Sprint 0 zatvoren.
- **0.2c deljenje i governance** (2026-10-12, noćni režim): `b808e7c` kod, testovi, docs;
  `ab4972c` migracija 003 (Uroš). 15 pretpostavki: `git show b808e7c:docs/NEXT.md` (sve
  prihvaćene; `request_id` ostaje `uuid`).

- **0.2b stranke i šifrovanje** (2026-10-12): `7fd5b9e` kod, testovi, docs; `4fafbe7` migracija
  002 (Uroš). 12 pretpostavki: `git show 7fd5b9e:docs/NEXT.md`. Dev ključ procureo u chat i
  zamenjen istog dana. Na `collect`: migracije 000–002; demo tenant 2 kupca, 2 kontakta, 3 ključa
  (2 subjekta + blind index tenanta), 0 email-ova u čistom tekstu; admin `scope = ORGANIZATION`.

- **0.2a Schema v1** (2026-10-11/12): `4bf31ef` testovi, seed, docs; `82b5905` migracija 001 (Uroš).
  18 pretpostavki iz noćnog režima: `git show 4bf31ef:docs/NEXT.md`.
  Na `collect`: `schema_migrations` = 000, 001; seed: 2 legal entities, po 1 tenant/user po
  kontekstu, audit tenant #0 = 3 reda (1 user.created + 2 tenant.provisioned), demo = 1.
- **0.1 Bootstrap** (2026-10-11): `bcde887` skelet, `335a261` zaštićeni fajlovi (Uroš). Detalji u ADR 0001.
