# NEXT

## Aktivan zadatak

**Sprint 1 zatvoren, sledeće: security review, pa Sprint 2 — kupci, fakture, uvoz.**

1. **Security review** u ODVOJENOJ sesiji: ulaz `docs/security-review-input.md` (diff
   `03cc604..HEAD`, zaštićeni fajlovi, ADR-ovi) + `docs/security-review-checklist.md`.
2. **Sprint 2** na grani `feature/*` od `develop` (git tok u runbook-u): kupci (Customer 360),
   fakture, uvoz CSV/Excel.

**Blokade za staging** (runbook „Release checklist"): Turnstile ključevi · Sentry DSN · off-site
bucket + ključevi (rclone je u worker image-u) · kanal za alarme · servisne role na Elestio pre
007/011 · `VALIDATE CONSTRAINT users_auth_user` · GitHub remote (CI, `/code-review`).

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

## Zatvaranje Sprinta 1 (2026-10-12, isti režim)

- **Dockerfile:** stage `worker` = app + `postgresql-client-16=16.15-1.pgdg12+2` + `rclone=1.60.1+dfsg-2+b5`
  (PGDG repo za `pg_dump` 16 = verzija servera); stage `app` je podrazumevani. Image izgrađen i
  proveren (alati, `/app/ops`, korisnik `node`). Backup i restore test rade iz worker-a; host cron
  je fallback.
- **Servisne role:** `create-service-roles.sh` (ranije `create-worker-role.sh`): `vigor_worker`,
  `vigor_backup` (`pg_read_all_data` + BYPASSRLS, ne piše), `vigor_restore`. Backup nikad kao
  superuser. Migracija 011: CONNECT za obe + trigger `ops_runs_kind_by_role`.
- **Matrica:** `team.read` (sve role), `team.manage` (owner, admin, collection_manager), migracija 011;
  ekran Timovi, rute i navigacija na novim ključevima.
- **Git tok:** `feature/*` → `develop` → `release/x.y` → `main`; `!` komande za merge u runbook-u.
  Grana `develop` se pravi u Uroševoj `!` komandi.
- **Testovi:** DB 202, unit 113, e2e 30 (+1 namerno preskočen); golden: `vigor_backup` ne može
  INSERT/UPDATE/DELETE, `vigor_restore` ne čita glavnu bazu, skripte rade bez superuser-a.

### Pretpostavke i nalazi

1. **Restore test kao posebna rola `vigor_restore`:** `vigor_backup` „bez pisanja" ne sme da pravi bazu, a restore test mora; `vigor_restore` ima CREATEDB + BYPASSRLS samo za svoju privremenu bazu i nema prava nad podacima glavne baze.
2. **Jedini upis ovih rola je sopstveni red u `ops_runs`** (rezultat posla). Nalaz: BYPASSRLS preskače i `WITH CHECK` politike — golden test je to uhvatio; ograničenje drži trigger.
3. **Backup je sada neuspeh ako lista baza padne ili nema glavne baze** (ranije bi prijavio „ok, 0 baza" — nalaz iz ove sesije).
4. Worker image nema git → bez `repo.bundle` u backup-u iz worker-a (repo je na GitHub-u kad postoji remote; do tada host cron pravi bundle).
5. Pin PGDG verzije: kad izađe 16.16, stara nestaje iz glavnog repoa → build pada dok se ne podigne `PG_CLIENT_VERSION` (runbook).
6. Dodele `team.*` rolama su podaci tenanta → seed (kao 004); postojeći tenanti ih dobijaju ponovnim seed-om.

## Poslednja sesija — lanac 1.6 → 1.7 (2026-10-12, noćni režim)

### Urađeno po bloku

- **1.6 timovi i scope — `3aca0ba`** (+ predlog 009): `teams`, `team_members` (jedan primarni
  tim po osobi), `customers.owner_team_id`; `scopeFilter()` jedini prevodi scope u predikat
  (golden statički test); Admin → Timovi; maker-checker za matricu (`approval.create` →
  `role.manage`); Admin → Odobrenja; 2 demo tima u seed-u.
- **1.7 ops — commit ove sesije** (+ predlog 010 i compose): Sentry (`@sentry/nextjs` 10.75.3,
  app + worker, `request_id` tag, release = verzija, PII scrubbing kroz `pii_field_registry`);
  alarmi (Telegram/Slack, bez env samo log, dedupe 1 h); `backup.sh` (sve baze, globals bez
  lozinki, git bundle, 30 + 12, off-site ako klijent postoji), `restore-test.sh` (broj redova iz
  dump-a vs. vraćena baza), `ops_runs`; `smoke.sh`; Status sistema sa backup / restore / Sentry /
  alarmima; worker cron za backup, restore test i alarme.
- **Stanje testova:** DB 200, unit 113, e2e 30 (+1 namerno preskočen), `next build` ✔. Mutacije:
  10 (4 + 6), svaka obara bar 1 test. Dev: backup 2 baze ✔, restore test ✔ (37 tabela / 1246 redova).

### Pretpostavke (najkonzervativnija opcija)

1. Timovi koriste `user.read` / `user.update` — matrica nema `team.*`; novi ključ traži tvoje odobrenje i migraciju kataloga.
2. „Jedan tim po korisniku" = parcijalni UNIQUE indeks nad `kind = 'primary'` (enum sa jednom vrednošću); proširenje je `ALTER TYPE … ADD VALUE` (aditivno), ne CHECK koji bi kasnije tražio DROP.
3. Matrica: predlaže `approval.create` (maker), odlučuje `role.manage` (🅼); admin ne može da predlaže (nema `approval.create`). Dozvole role `owner` se ne menjaju ovim tokom.
4. Odluka o zahtevu: ruta traži `user.assign` ILI `role.manage` (`requireAnyPermission`), servis proverava tačan ključ po vrsti zahteva.
5. Kupci bez vlasnika vidljivi samo uz `ORGANIZATION`; `TEAM` bez tima = `OWN`.
6. `@sentry/nextjs` 10.75.3 (ne 11.0.0 — novi major star 3 nedelje); samo server (app + worker), bez tracinga i replay-a.
7. Backup traži superuser (`pg_dump` i FORCE RLS); `BACKUP_DATABASE_URL` ili `POSTGRES_*`.
8. Worker image nema `pg_dump`, `rclone` ni `aws`: isto pravilo kao tvoje za rclone/aws — ne dodajem paket; worker posao loguje razlog, alarm „backup do 06:00" to vidi; do odluke host cron.
9. Rezultati backup-a i restore testa u `ops_runs` (platformska tabela, piše samo skripta kao superuser, app čita) — worker i dalje nema politike van `domain_events`/`mail_outbox`.
10. Restore test broji redove iz COPY blokova dump-a (bez trke sa izmenama) i poredi sa listovima vraćene baze (particije uključene).
11. Smoke „upit kroz test korisnika" = upit kao `vigor_app` sa `SMOKE_TENANT_ID` (0 bez tenanta, > 0 sa njim): prijava kroz UI je u production-u iza Turnstile-a i TOTP-a.
12. Alarm dedupe u memoriji worker-a (restart ga resetuje) — BACKLOG.
13. Scrubber maskira email, nizove od 8–13 cifara (PIB, MB, JMBG) i IBAN u tekstu; imena se hvataju po ključu (registar + osnovna lista), ne iz slobodnog teksta.

### Odluke Uroša za lanac 1.6 → 1.7 (2026-10-12)

- BACKLOG P2: hook pada ako je broj preskočenih testova veći od očekivanog (1).
- Release checklist: `scripts/create-worker-role.sh` kao superuser PRE migracije 007 — blokirajuće.
- `@sentry/nextjs` odobren kao jedini novi paket u 1.7.

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

- **Lanac 1.3 → 1.4 → 1.5** (2026-10-12): `6ea8b99`, `c207067`, `a18b6c5`; `cc26a28` migracije
  007 + 008, `src/server/auth/*`, compose (Uroš). 16 pretpostavki: `git show a18b6c5:docs/NEXT.md`.

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
