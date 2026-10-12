# NEXT

## Aktivan zadatak

**1.6 timovi** — `teams` / `team_members`, `TEAM` scope prestaje da bude `OWN`; posle Uroševe
`!` komande za 007, 008 i `src/server/auth/*` (izveštaj lanca 1.3 → 1.5) i `docker-compose.yml`.

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

## Poslednja sesija — lanac 1.3 → 1.4 → 1.5 (2026-10-12, noćni režim)

### Urađeno po bloku

- **1.3 outbox — `6ea8b99`** (+ predlog 007): rola `vigor_worker` (skripta kao superuser, ne
  migracija — `vigor_migrate` je NOCREATEROLE); politike samo na `domain_events` i `mail_outbox`;
  worker proces (isti image, `node worker.mjs`, `PROCESS_ROLE=worker` kroz `instrumentation.ts`);
  pg-boss (`id` posla = id događaja), `withTenantJob()`, 3 ponavljanja → `failed` vidljiv;
  `tenant_clock()` + dnevni posao u 06:00 po zoni tenanta (ključ tenant + lokalni datum, DST);
  retention; `/health` sa zbirovima poslova. ADR 0005.
- **1.4 security — `c207067`** (+ predlog 008): nonce CSP bez `unsafe-inline` za skripte, HSTS
  (prod), XFO DENY, no-referrer, Permissions-Policy, CORS samo naš origin; CSRF (Better Auth
  provere eksplicitno uključene, `withTenant` traži naš Origin); rate limit 120/min po IP-u u bazi;
  Turnstile (Better Auth `captcha` plugin + adapter za pozivnicu; prod bez ključeva izlazi sa 1);
  Zod golden nad svim rutama; greška uvek `{code, message_key, request_id}`. ADR 0006.
- **1.5 prvi ekrani — commit ove sesije**: shell (navigacija po permisijama, oznaka organizacije,
  promena, odjava, PWA install), Admin → Korisnici (pozivnica, ponovo, promena role sa četiri oka
  za owner/admin, deaktivacija), Admin → Podešavanja (audit + događaj), Admin → Status sistema,
  dashboard sa praznim stanjem, PWA ikone. `withTenantPage()` za server komponente.
- **Stanje testova:** DB 186, unit 102, e2e 30 (+1 namerno preskočen), `next build` ✔. Mutacije:
  14 pokvarenih zaštita (5 + 5 + 4), svaka obara bar 1 test.

### Pretpostavke (najkonzervativnija opcija)

1. `vigor_worker` se pravi `scripts/create-worker-role.sh` (superuser); 007 odbija rad bez nje.
2. pg-boss tabele pravi pg-boss kao `vigor_worker` u šemi `pgboss` (iz migracije); van RLS konvencije, bez tenant podataka.
3. `tenant_clock()`: SECURITY DEFINER (vlasnik `vigor_migrate`) + politika za vlasnika aktivna samo uz GUC unutar funkcije — worker nema politiku na `tenants`/`tenant_settings`.
4. Dnevni posao je po tenantu (zona `tenant_settings.timezone`); kompanije u drugim zonama ne menjaju dan tenanta. Poslovi po kompaniji → kad zatrebaju.
5. Sink → „poslato" nije urađeno: CHECK iz 006 bi tražio DROP CONSTRAINT; uhvaćen sink red je već isporuka.
6. Trigger iz 006 (demo → samo sink) zamenjen u 007 kroz `CREATE OR REPLACE` (bez DROP): proverava INSERT i promenu `transport`; worker ne može da menja `transport`.
7. `/health` je javna i vraća zbirove poslova (bez podataka); app ih čita kroz `job_health()` (SECURITY DEFINER), worker pri startu daje `SELECT ON pgboss.job` vlasniku.
8. Worker se pakuje kroz Next `instrumentation.ts` (esbuild nije direktna zavisnost).
9. Semgrep pravilo „Vigor" dozvoljava i `vigor_worker` (ime role iz tvog zadatka i ADR 0002).
10. Vitest uvek radi sa `NODE_ENV=test` (ovaj kontejner ima `NODE_ENV=production` u shell-u).
11. Better Auth origin/CSRF provere eksplicitno uključene (inače su isključene pod `NODE_ENV=test`).
12. `style-src-attr 'unsafe-inline'` ostaje (style atributi Next-a i Turnstile-a ne izvršavaju kod).
13. Rate limit: propušta ako baza ne odgovori (log); `X-Forwarded-For` se veruje (iza proksija).
14. Promena role: `user.update` podnosi, `user.assign` (🅼) odlučuje; obične role bez odobrenja, scope ostaje.
15. Deaktivacija: ne sebe, admin ne owner-a; pozivnice te osobe se opozivaju.
16. Dev `.env` dobio Cloudflare-ove javne Turnstile test ključeve (nisu tajna) da compose radi lokalno; `WORKER_DB_PASSWORD`/`WORKER_DATABASE_URL` generisani, nisu ispisani.

### Odluke Uroša za lanac 1.3 → 1.5 (2026-10-12)

- `mail_outbox` ključ izveden iz master ključa — u ADR 0003 kao privremen; ujediniti sa
  `subject_keys` posle go-live (expand → contract); rotacija mora pokriti oba puta.
- `qrcode`: BACKLOG — zameniti kad postoji održavana alternativa.

### Odluke Uroša za lanac (2026-10-12)

- Sink (a): `mail_outbox` sa `recipient_enc` / `body_enc` kroz keyring; retencija 7 dana u 1.3.
- `tenants.is_demo`: demo = true, Sinergista = false; demo nikad SMTP (adapter + trigger + test).
- `verification.storeIdentifier: 'hashed'` — nalaz u ADR 0004.
- Pozivnica: `user_roles` iz `role_key`; owner poziva sve role, admin sve osim owner-a.

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

- **Worker traži ručni korak po klasteru** (rola) pre 007 — bez toga migracija stoji.
- **Turnstile zavisi od Cloudflare mreže**: kad CF ne radi, prijava ne radi (pada zatvoreno).
- **e2e traži mrežu** (Turnstile test ključevi) i `collect_test` sa 007/008.
- **Nema SMTP-a**: sve u sink do odobrenja `nodemailer`.
- **`qrcode` bez izdanja od 2024-08** — izuzetak od pravila 14 (BACKLOG).
- **Better Auth nadogradnja = moguća migracija** (`getMigrations()` uporediti sa 005).
- **Matrica permisija je pretpostavka o poslovnim ulogama** (0.3); izmena = `docs/permissions.md` + nova migracija.

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

- **Lanac 1.1b → 1.1c → 1.2** (2026-10-12): `273f1ad`, `431ec69`, `e41fa02`; `0633c3b` migracija
  006 + `src/server/auth/*` (Uroš). 15 pretpostavki: `git show e41fa02:docs/NEXT.md`.

- **1.1a autentifikacija** (2026-10-12): `a08c05f` testovi, ruta, seed, docs; `ded50d5` ispravka
  politike + odluke; `9ab892e` migracija 005 + `src/server/auth/*` (Uroš). 15 pretpostavki:
  `git show ded50d5:docs/NEXT.md`.

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
