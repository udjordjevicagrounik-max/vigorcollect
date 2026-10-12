# NEXT

## Aktivan zadatak

**1.1b Pozivnice i auth ekrani** — posle Uroševog commit-a 005 i `src/server/auth/*` (`!`
komanda u izveštaju 1.1a). Obim: pozivnica (hash tokena, 72 h, jednokratna, email u sink),
ekrani login / MFA unos / MFA setup (QR, `qrcode` odobren) / prihvatanje pozivnice / lockout
poruka (`mobile-full`, `t()` sr + en, prazno/greška), email servis + sink, testovi pozivnica.

### Sprint 1 plan (1.1–1.7)

1. **1.1 auth** — Better Auth (šema `auth`), lozinka + TOTP, sesija 8 h, lockout, pozivnice, ekrani.
2. **1.2 tenant helperi** — `withTenant()` (tenant isključivo iz sesije), `requirePermission()`, `audit()`.
3. **1.3 outbox** — `domain_events` dispatcher, `vigor_worker` (ADR 0002 „Otvoreno" 2).
4. **1.4 security** — maker-checker kroz `approval_requests`, security review checklist, IDOR testovi.
5. **1.5 prvi ekrani** — po wireframe-ima iz 0.3 (`docs/wireframes/`), `t()` sr + en.
6. **1.6 timovi** — `teams` / `team_members`, `TEAM` scope prestaje da bude `OWN`.
7. **1.7 ops** — backup + restore test, `verify-tenant` / `rls-drift` nad živom bazom, smoke posle deploya.

Numeracija važi od Sprinta 1 i zamenjuje raniju (1.3 login, 1.4 maker-checker, 1.5 outbox,
1.6 verify/backup) u starijim beleškama i komentarima.

## Poslednja sesija — 1.1a autentifikacija (2026-10-12, noćni režim)

### Urađeno

- **Migracija 005 (predlog, NIJE commit-ovana)** `db/migrations/005_auth_{up,down}.sql`: šema
  `auth` (6 tabela Better Auth-a + `failedSignInCount`/`signInLockedUntil`), ENABLE + FORCE RLS
  bez tenant predikata, `vigor_app` samo DML; FK `users.auth_user_id` (NOT VALID);
  `app_auth_user_id()` + politika `auth_membership_read` (SELECT, samo sopstveni redovi u
  `users` i nazivi tih tenanta, samo dok tenant nije izabran); PII registar za `auth.*`.
- **`src/server/auth/*` (predlog, zaštićeno)**: `better-auth.ts` (konfiguracija, hook-ovi za
  zaključavanje, `activeTenantId` + provera članstva), `memberships.ts`, `session.ts`
  (`getAuthContext()`: anonymous / mfa_setup_required / tenant_required / ok), README.
- Ruta `src/app/api/auth/[...all]/route.ts`; seed pravi prijavne naloge za admine (samo uz
  `SEED_ADMIN_PASSWORD` + `BETTER_AUTH_SECRET`); `.env.example`.
- **Testovi**: `tests/golden/db/auth.test.ts` (17): lozinka + TOTP → sesija vezana za tenant,
  kolačić HttpOnly/SameSite, bez TOTP-a nema pristupa, pogrešan TOTP, isti odgovor za
  nepostojeći email (prijava i reset), politika članstava samo pre izbora tenanta, 5 promašaja → 15 min sa istim odgovorom i otključavanje,
  TOTP lockout konfiguracija, 429 posle 10 pokušaja sa jednog IP-a, sesija 8 h apsolutno (fake
  timer), izbor tenanta samo među sopstvenim članstvima, izolacija, deaktivirano članstvo.
  Golden `rls` i `pii-registry` prošireni na šemu `auth`. DB 120/120, unit 33/33, `next build` ✔.
  Mutacioni test: 4 pokvarene zaštite → svaka obara bar 1 test.
- **Docs**: ADR 0004 (uz obrazloženje za pravilo 10), ADR 0002 „Otvoreno" 1 zatvoreno, runbook
  „Auth" (tajna, otključavanje, reset MFA), javne rute u `permissions.md`, BACKLOG „Iz 1.1a".

### Nije urađeno (1.1b)

- Pozivnice, 5 ekrana, email servis + sink, QR (`qrcode`), testovi pozivnica.
- `BETTER_AUTH_*` u `docker-compose.yml` (zaštićen) — pre prvog deploy-a sa prijavom.

### Pretpostavke (najkonzervativnija opcija)

1. `auth` tabele imaju ENABLE + FORCE RLS sa politikama bez tenant uslova (ne „bez RLS-a") — golden pravilo „svaka tabela FORCE" ostaje bez izuzetka.
2. Nazivi tabela/kolona su Better Auth-ovi (camelCase); DDL je preslikan iz `getMigrations()`.
3. `generateId: 'uuid'` — `users.auth_user_id` je već `uuid` iz 001.
4. Članstva se čitaju politikom `auth_membership_read` (GUC `app.auth_user_id`), ne SECURITY DEFINER funkcijom (`vigor_migrate` je pod FORCE RLS).
5. FK `users_auth_user` je NOT VALID (dev `down 005` ostavlja viseće id-jeve koje RLS krije); VALIDATE pre prvog staging deploya (odluka ispod).
6. Jedno članstvo → tenant se bira sam; više → `/update-session`, provereno hook-om; `getAuthContext()` proverava članstvo na svakom zahtevu.
7. Zaključavanje: brojač se nulira u trenutku zaključavanja; pokušaji tokom zaključavanja ne produžavaju ga.
8. MFA je obavezan kroz `getAuthContext()` (Better Auth sam ne tera upis TOTP-a).
9. Rate limit: prijava i TOTP 10/min, reset 5 / 5 min, ostalo 100/min po IP-u.
10. Lozinka min. 12 znakova; reset token 1 h; reset opoziva sve sesije; javna registracija isključena.
11. Kolačić SameSite=Lax (Strict bi pokvario linkove iz emaila za reset i pozivnicu).
12. Seed pravi prijavne naloge samo uz `SEED_ADMIN_PASSWORD` i `BETTER_AUTH_SECRET`; TOTP pri prvoj prijavi.
13. Reset lozinke: `mailer` ne šalje ništa do 1.1b (odgovor je isti bez obzira).
14. PII registar za `auth` koristi imena `auth.<tabela>`; registar golden test pokriva `public` i `auth`.
15. Test sam računa TOTP (RFC 6238, `node:crypto`) — bez paketa.

### Odluke Uroša posle 1.1a (2026-10-12)

- **Ispravka 005 (urađena):** `auth_membership_read` na `users` i `tenants` važi samo dok tenant
  nije izabran (`app_tenant_id() IS NULL`) — politike su permissive (OR), pa bi inače sesija u
  tenantu A videla i sopstveni red u tenantu B. Golden test sa oba GUC-a; mutacija ga obara.
- **Secure kolačić (1.1b):** `secureCookies = true` uvek, osim kad je `NODE_ENV !== 'production'`
  **i** `BETTER_AUTH_URL` počinje sa `http://localhost` ili `http://127.0.0.1`. Nikad env flag
  koji ga isključuje u prod-u. Uz unit test za sve kombinacije.
- **NOT VALID FK:** `VALIDATE CONSTRAINT users_auth_user` pre prvog staging deploya — BACKLOG i
  runbook „Release checklist".
- **`SEED_ADMIN_PASSWORD`:** Uroš upisuje ručno u `.env`, nikad kroz chat.

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

- **Bez `BETTER_AUTH_SECRET` u `.env` aplikacija i seed ne prave prijavu** (seed preskače uz
  poruku; `/api/auth` vraća grešku). Generisanje: runbook „Auth".
- **Lokalno nema HTTPS-a**: kolačić je `Secure`; za ručno testiranje u browseru treba HTTPS
  (Elestio) ili `secureCookies: false` samo u dev konfiguraciji — odluka u 1.1b.
- **Better Auth nadogradnja = moguća migracija** (`getMigrations()` uporediti sa 005).
- **`requirePermission` / `withTenant()` (1.2) još ne postoje** — `getAuthContext()` je spreman
  izvor tenanta.
- **Matrica permisija je pretpostavka o poslovnim ulogama** (0.3); izmena = `docs/permissions.md`
  - nova migracija.
- **Wireframe tekst nije kroz `t()`**; tabele faktura/uplata/case-ova još ne postoje.
- **`PII_MASTER_KEYS` i `BETTER_AUTH_*` nisu u `docker-compose.yml`** (zaštićen).

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

- **1.1a autentifikacija** (2026-10-12, noćni režim): commit ove sesije (testovi, ruta, seed,
  docs); 005 i `src/server/auth/*` čekaju Uroša.
- **0.3 permisije i wireframe-i** (2026-10-12, noćni režim): `e861e22` matrica + role,
  `33a07a0` wireframe-i, `9f667af` migracija 004 (Uroš). 13 pretpostavki:
  `git show 33a07a0:docs/NEXT.md`. Sprint 0 zatvoren.
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
