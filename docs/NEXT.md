# NEXT

## Aktivan zadatak

**1.3 outbox** — `domain_events` dispatcher, rola `vigor_worker` (ADR 0002 „Otvoreno" 2),
retention job za `mail_outbox` (7 dana) i isteklih `auth.session` / `auth.verification`.
Pre toga: Uroševa `!` komanda za 006 + `src/server/auth/*` (izveštaj lanca 1.1b → 1.2).

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

## Poslednja sesija — lanac 1.1b → 1.1c → 1.2 (2026-10-12, noćni režim)

### Urađeno po bloku

- **1.1b backend — `273f1ad`** (+ predlozi): migracija 006 (`tenants.is_demo`, `user_invitations`
  sa hešom tokena + trigger za konačnost/istek + politika `invite_token_lookup` samo pre tenanta,
  `mail_outbox` šifrovan + trigger „demo samo sink"); `src/server/mail` (adapter, sink, HKDF
  ključ, auth mailer); `invitations.ts`; Secure kolačić po odluci; `storeIdentifier: 'hashed'`;
  promena lozinke gasi ostale sesije; `scripts/dev-admin-password.ts`; runbook „Prvi login" i
  „Ponovno slanje pozivnice". Testovi: 16 DB (pozivnice, sink, reset, sesije) + 36 unit.
- **1.1c ekrani — `431ec69`**: `/login`, `/login/mfa`, `/settings/mfa-setup` (QR + ručni ključ +
  rezervni kodovi), `/invite/[token]`, `/settings/password`, `/select-tenant`, generička poruka
  (pogrešna lozinka = nepostojeći = zaključan nalog); shell traži punu sesiju; honeypot;
  `qrcode` 1.5.4. Playwright na `collect_test`: login → MFA setup → MFA → shell na 375 px.
- **1.2 tenant helperi — commit ove sesije** (+ predlozi): `withTenant()` (tenant samo iz
  sesije, `RESET app.auth_user_id`, fail-closed bez `requirePermission()` / mutacija bez
  `audit()`), `requirePermission()` (najširi scope), `audit()` sa redakcijom kroz
  `pii_field_registry`; rute `POST /api/invitations`, `POST /api/invitations/[id]/revoke`,
  `GET /api/users/[id]`. Golden: statički test ruta, IDOR → 404, audit po mutaciji.
- **Stanje testova:** DB 154/154, unit 73/73, e2e 23/23, `next build` ✔. Mutacije: 11 namerno
  pokvarenih zaštita (5 u 1.1b, 6 u 1.2) — svaka obara bar 1 test.

### Pretpostavke (najkonzervativnija opcija)

1. Ključ za `mail_outbox`: HKDF iz `PII_MASTER_KEYS` po tenantu, ne `subject_keys` — CHECK
   `subject_keys_purpose_subject` ne dozvoljava `tenant`+`data`, a izmena bi bila DROP CONSTRAINT.
2. SMTP ne postoji (`nodemailer` nije u zavisnostima): svi tenanti pišu u sink; `smtpEnabled = false`.
3. Reset lozinke ide u sink tenanta u kome je osoba član — demo članstvo ima prednost; bez
   članstva se ništa ne šalje (odgovor isti).
4. Pozvani korisnik dobija scope `OWN`; širi scope = `user.assign` (maker-checker, 1.4).
5. Osoba koja već ima nalog prihvata pozivnicu samo prijavljena (nema postavljanja lozinke tuđem nalogu).
6. Pozivnica: tenant se nalazi preko heša tokena (pre tenanta), nikad iz zahteva; prihvatanje je van `withTenant()` jer osoba još nema tenant sesiju.
7. Re-send = nova pozivnica; prethodna `revoked` (token se ne može povratiti).
8. `dev-admin-password.ts`: „host" = `BETTER_AUTH_URL` (baza je na 172.17.0.1 i u dev-u i na Elestio, pa ne razlikuje okruženja); dodat uslov „izlaz je terminal" da lozinka ne uđe u chat ni log; ovaj kontejner ima `NODE_ENV=production` → runbook kaže `NODE_ENV=development`.
9. `qrcode` zadržan iako je poslednje izdanje 2024-08 (pravilo 14: 12 meseci) — izričito odobren u 3b; obrazloženje u commit poruci, praćenje u BACKLOG-u.
10. Turnstile (pravilo 27) nije urađen: traži Cloudflare ključeve → BACKLOG + blokada u release checklisti; honeypot + rate limit po IP-u do tada.
11. Ekrani za reset lozinke i unos rezervnog koda → BACKLOG (nisu među 7 traženih).
12. `audit()` čuva vrednost samo za kolone registrovane kao P0 bez uslova; sve ostalo, i nepoznati ključevi, postaje `[redacted]`.
13. `requirePermission` vraća najširi scope; 🅼 (samo checker) se još ne razlikuje → 1.4.
14. Neuspeh tenant rute: 401 za nepotpunu sesiju, 403 `{"error":"forbidden"}`, 404 i za tuđ id, 409 sa kodom, 400 `invalid_request`, 500 `internal` + JSON log.
15. E2E radi na `collect_test` sa identitetom napravljenim za svako pokretanje; sesija iz setup projekta se deli (8 h, briše se u teardown-u).

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

- **Turnstile nedostaje (pravilo 27)** — blokada pre staging-a (release checklist).
- **`qrcode` bez izdanja od 2024-08** — izuzetak od pravila 14; zamena = ručni ključ (već na ekranu).
- **Nema SMTP-a**: pozivnice i reset za ne-demo tenante ostaju u sink-u dok se ne odobri `nodemailer`.
- **Prihvatanje pozivnice nema rate limit po IP-u** (token 256 bita) — BACKLOG.
- **`BETTER_AUTH_*` i `PII_MASTER_KEYS` nisu u `docker-compose.yml`** (zaštićen) — pre deploya sa prijavom.
- **Better Auth nadogradnja = moguća migracija** (`getMigrations()` uporediti sa 005).
- **Matrica permisija je pretpostavka o poslovnim ulogama** (0.3); izmena = `docs/permissions.md` + nova migracija.
- **Stranice još ne čitaju podatke tenanta** (`withTenant` je za API); server komponente sa podacima u 1.5.

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
