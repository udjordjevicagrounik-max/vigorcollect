# Runbook

_Popunjava se kroz 1.6 (backup/restore) i prvi deploy._

## `!` komande (Claude Code)

Svaka `!` komanda se izvršava iz `/opt/app` i `cd` se ne pamti između komandi. **Svaka `!`
komanda za repo počinje sa `cd /srv/vigor-collect &&`**, npr.:

```bash
! cd /srv/vigor-collect && git status
! cd /srv/vigor-collect && git add db/migrations/001_* && git commit -m "..."
```

## Početak svake sesije (dev kontejner)

```bash
cd /srv/vigor-collect
./scripts/setup-tools.sh        # 1. psql 16, gitleaks, semgrep + test baza collect_test
docker compose up -d db         # 2. baza (ako nije podignuta)
./scripts/migrate.sh status     # 3. stanje migracija
cat docs/NEXT.md                # 4. aktivan zadatak
```

Alati žive u ovom kontejneru, ne u repou, i mogu da nestanu posle restarta/rebuild-a kontejnera.
Bez njih pre-commit hook pada — ne zaobilaziti (`--no-verify` je zabranjen).

## Test baza (`collect_test`)

Golden DB testovi (`npm run test:db`, deo pre-commit hook-a) rade **samo** na `collect_test`,
nikad na dev bazi `collect`. Kreira je `scripts/setup-test-db.sh` (poziva je `setup-tools.sh`),
sa istim pravima kao dev baza. `test:db` sam primenjuje pending migracije na test bazu i pada sa
porukom „pokreni db (runbook korak 2)" ako baza ne radi. Fixture podaci (fiksni UUID-ovi) ostaju
u test bazi trajno — `audit_log` je INSERT-only.

Reset test baze: `MIGRATE_DATABASE_URL=<test url> ./scripts/migrate.sh down NNN` pa `up`.

## PII master ključ (`PII_MASTER_KEYS`)

Šifruje ključeve podataka u `subject_keys` (ADR 0003). Bez njega seed i svaki rad sa
kontaktima padaju. **Nikad u repo, bazu, backup, log ili chat** (pravila 9, 28).

Pravila:

- Ključ se proverava **isključivo** sa `grep -c '^PII_MASTER_KEYS=.' .env` (očekuje se `1`) —
  nikad `grep` bez `-c`, `cat`, `echo` ni bilo šta što ispisuje vrednost.
- **Dev ključ je potrošan** i ne čuva se u vault-u; obnavlja se postupkom zamene ispod (demo
  podaci se ponovo prave iz seed-a).
- **Staging/prod ključevi** se generišu van chata (SSH na instancu ili Elestio env panel) i
  čuvaju u vault-u (dve nezavisne kopije) — **nikad kroz Claude sesiju**, nikad u backup-u baze.
  Restore baze bez ključa = nečitljiv PII; gubitak ključa je nepovratan za sve P1–P3 podatke.
- Ako se ključ pojavi u čistom tekstu **bilo gde** (chat, log, terminal, commit): smatra se
  kompromitovanim → odmah zamena.

Prvo generisanje / zamena dev ključa (samo dev baza). `migrate.sh down` vraća samo POSLEDNJU
migraciju, pa se vraća sve od najnovije do 002 (stanje posle 005: `down 005`, `down 004`,
`down 003`, `down 002`). Briše prijavne naloge (seed ih ponovo pravi), demo kupce, kontakte, ključeve i tabele
deljenja/governance; `audit_log` i
role ostaju, a `down 004` zadržava permisije koje su dodeljene rolama (NOTICE, `up` ih preskače):

```bash
! cd /srv/vigor-collect && sed -i '/^PII_MASTER_KEYS=/d' .env && echo "PII_MASTER_KEYS=1:$(openssl rand -base64 32)" >> .env && ./scripts/migrate.sh down 005 && ./scripts/migrate.sh down 004 && ./scripts/migrate.sh down 003 && ./scripts/migrate.sh down 002 && ./scripts/migrate.sh up && npm run seed && grep -c '^PII_MASTER_KEYS=1:' .env
```

Format: `verzija:base64(32 bajta)`, više verzija odvojeno zarezom; najviša šifruje nove ključeve.
Rotacija na staging/prod (bez gubitka podataka): dodati `N+1:<novi>`; stari ostaje dok re-wrap
job ne prijavi 0 redova (ADR 0003). Zamena „down → up → seed" važi **samo za dev**.

## Auth (Better Auth, ADR 0004)

Promenljive: `BETTER_AUTH_SECRET` (≥ 32 bajta), `BETTER_AUTH_URL` (javni origin), za dev još
`SEED_ADMIN_PASSWORD`. Pravila kao za PII ključ: **nikad u chat, log, repo ni backup**; proverava
se samo sa `grep -c`. Gubitak ili zamena `BETTER_AUTH_SECRET` = sve sesije prestaju i svi
korisnici ponovo podešavaju TOTP (tajne su šifrovane njime).

Dev — generisanje tajne (staging/prod: van chata, vault):

```bash
! cd /srv/vigor-collect && sed -i '/^BETTER_AUTH_SECRET=/d' .env && echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env && grep -c '^BETTER_AUTH_SECRET=.' .env
```

`SEED_ADMIN_PASSWORD` (min. 12 znakova) Uroš upisuje sam u `.env` u editoru — ne kroz chat.
Posle toga `npm run seed` pravi prijavne naloge za `admin@sinergista.example` i
`admin@demo.example`; TOTP se podešava pri prvoj prijavi (`/settings/mfa-setup`).

Ručne intervencije (do admin ekrana sa maker-checker-om, 1.4) — kao `vigor_migrate`, uz zapis
u audit tenanta #0 (`actor_type = 'system'`, razlog u `after`):

```bash
# Otključavanje posle 5 pogrešnih lozinki (inače se samo otključa posle 15 min)
psql "$MIGRATE_DATABASE_URL" -v email='osoba@firma.example' <<'SQL'
UPDATE auth."user" SET "failedSignInCount" = 0, "signInLockedUntil" = NULL WHERE email = lower(:'email');
SQL

# Reset MFA (izgubljen telefon i rezervni kodovi): briše TOTP i sve sesije → nova registracija
# TOTP-a pri sledećoj prijavi. Pre toga: identitet osobe potvrđen van kanala (poziv, lično).
psql "$MIGRATE_DATABASE_URL" -v email='osoba@firma.example' <<'SQL'
BEGIN;
DELETE FROM auth."twoFactor" WHERE "userId" = (SELECT id FROM auth."user" WHERE email = lower(:'email'));
DELETE FROM auth."session"   WHERE "userId" = (SELECT id FROM auth."user" WHERE email = lower(:'email'));
UPDATE auth."user" SET "twoFactorEnabled" = false WHERE email = lower(:'email');
COMMIT;
SQL
```

### Prvi login admina na dev

1. `.env` ima `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:13000` i
   `SEED_ADMIN_PASSWORD`; `npm run seed` pravi prijavni nalog za `admin@demo.example`.
2. Lozinka je `SEED_ADMIN_PASSWORD` (pročitaj je sam u editoru) **ili** nova, jednokratno
   ispisana — u **svom SSH terminalu, nikad kroz Claude (`!`)**:

   ```bash
   cd /srv/vigor-collect && NODE_ENV=development npx tsx scripts/dev-admin-password.ts
   ```

   Skripta odbija rad ako `NODE_ENV=production`, baza nije `collect`, `BETTER_AUTH_URL` nije
   `http://localhost` / `http://127.0.0.1` ili izlaz nije terminal (pipe, log, chat). Gasi sve
   sesije admina i nulira brojač promašaja; TOTP ostaje.

3. `BETTER_AUTH_URL/login` → email + lozinka → `/settings/mfa-setup` (QR ili ručni unos tajne u
   aplikaciju za autentifikaciju) → kod → **odmah `/settings/password`** (nova lozinka gasi sve
   ostale sesije).

### Ponovno slanje pozivnice

- Token pozivnice se ne čuva (samo SHA-256), pa se isti link ne može poslati ponovo.
  Ponovno slanje = **nova pozivnica za isti email** (owner/admin, `user.create`,
  `POST /api/invitations` sa `{email, displayName, roleKey}`): prethodna se automatski opoziva,
  nova važi 72 h. Opoziv bez nove: `POST /api/invitations/{id}/revoke`. Ni u audit-u ni u logu nema tokena ni email adrese.
- Istekla pozivnica kaže da je istekla; iskorišćena, opozvana i nepostojeća izgledaju isto
  („link nije važeći"). U oba slučaja korisnik traži novu od admina.
- Osoba koja već ima nalog (član drugog tenanta) prvo se prijavi, pa otvori link.
- Demo tenant: mejl postoji samo u sink-u (`mail_outbox`, šifrovano, `transport = 'sink'`); nikad
  se ne isporučuje (pravilo 24). Pregled sink-a u aplikaciji: BACKLOG.
- Do SMTP-a (BACKLOG) i ostali tenanti pišu samo u sink.

## Worker (ADR 0005)

Rola `vigor_worker` se pravi **jednom po klasteru, pre migracije 007** (migracija bez nje odbija
rad). Dev: `WORKER_DB_PASSWORD` i `WORKER_DATABASE_URL` u `.env` (generisani, nikad u chat), pa:

```bash
! cd /srv/vigor-collect && ./scripts/create-worker-role.sh && ./scripts/migrate.sh up
```

Staging/prod: na Elestio hostu, sa vrednostima iz vault-a eksportovanim u shell (van Claude
sesije), isti skript (`POSTGRES_USER`/`POSTGRES_PASSWORD` = superuser). Provera:
`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vigor_worker';` → `f`, `f`.

Pokretanje: servis `worker` u `docker-compose.yml` (isti image, `node worker.mjs`, port nije
objavljen; `/health` na 3001 unutar mreže). Lokalno: `npm run build` pa
`cd .next/standalone && node worker.mjs` (iz `.env`: `DATABASE_URL`, `WORKER_DATABASE_URL`).

Neuspeli događaji (`status = 'failed'`, `last_error` = kod greške) ostaju u `domain_events`.
Ponovno slanje posle ispravke — kao `vigor_migrate`, u kontekstu tenanta, uz audit tenanta #0:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant uuid>', true);
UPDATE domain_events SET status = 'pending', last_error = NULL WHERE id = '<event uuid>' AND status = 'failed';
COMMIT;
```

`/health` → `jobs.failed` > 0 ili `jobs.oldestPendingSeconds` > 300 = proveriti worker log
(`outbox.failed`, `worker.error`). `jobs` = `null` → worker još nije startovao na toj bazi.

## DB uloge na Elestio (staging/prod)

Lokalno ih kreira `db/init/01-roles.sh`. Na Elestio instanci izvršiti iste naredbe ručno kao
superuser (jednom po instanci), sa lozinkama iz vault-a — nikad iz repoa.
Provera: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vigor%';`
→ oba reda moraju imati `f`, `f`.

## Deploy

`docker compose up -d app` — nikad `restart` (diže stari image).
Posle deploya: smoke (`/health` 200 + `X-App-Version` = očekivani tag).

### Release checklist (pravilo 23; dopunjuje se kroz 1.7)

- [ ] Testovi zeleni (`npm test`, `npm run test:db`), migracije probane na kopiji prod baze.
- [ ] **Pre prvog staging deploya:** `ALTER TABLE users VALIDATE CONSTRAINT users_auth_user;`
      (kao `vigor_migrate`). Ako padne — postoje viseći `auth_user_id`: očistiti, pa ponoviti.
- [ ] `BETTER_AUTH_URL` je `https://…`; Secure kolačić se ne isključuje nikakvim env flagom.
- [ ] **Turnstile** na login/reset/pozivnici (pravilo 27, BACKLOG „Iz 1.1c”) — bez toga nema staging-a.
- [ ] Release notes + rollback korak zapisani.

## Backup / restore

TODO(1.6): `scripts/backup.sh`, restore test (baza + fajlovi + `PII_MASTER_KEYS` iz vault-a,
nikad iz backup-a).
