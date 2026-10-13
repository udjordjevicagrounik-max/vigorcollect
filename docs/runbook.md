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
./scripts/migrate.sh status     # 3. stanje migracija (kroz servis `migrate`, gradi image)
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

## Migracije (pravilo 4; security review S-04)

`vigor_migrate` (vlasnik svih tabela) postoji samo u one-shot compose servisu `migrate` (profil
`ops`) — nikad u `app`, `worker` ni `renderer`. `./scripts/migrate.sh [up|status|down NNN]` bez
`MIGRATE_DATABASE_URL` u okruženju (iz `.env` se više ne čita) poziva:

```bash
docker compose --profile ops run --rm --build migrate up
```

`--build` pakuje trenutne `db/migrations` u image (worker stage, `ops/migrate.sh`). Direktan
`psql` mod ostaje samo kad je URL eksplicitno u okruženju: unutar servisa i za test bazu
(`scripts/test-db.sh`).

E2E (`npm run test:e2e`, Playwright) diže dva procesa iz istog production build-a, oba na
`collect_test`: app na `E2E_PORT` (podrazumevano 3100) i job worker na `E2E_WORKER_PORT`
(podrazumevano 3191) — uvoz faktura primenjuje worker, kao u produkciji. Tenant `0e2e…` ima svoju
kompaniju (zona UTC); podaci uvoza ostaju između pokretanja (uvoz je idempotentan).

## Uvoz faktura i dnevni posao naplate (Sprint 2)

- Uvoz: `/import` (CSV ili XLSX, do 5 MB i 20.000 redova). Demo fajl:
  `npx tsx scripts/demo-import/generate.ts > scripts/demo-import/fakture-demo.csv`.
  Potvrđen uvoz obrađuje worker (događaj `import.confirmed`); ako worker ne radi, uvoz ostaje
  „u obradi". Rollback uvoza: dugme u izveštaju (`import.create`).
- Dnevni posao tenanta (posle 06:00 lokalno, `tenant-daily`): evaluacija obećanja (D+`promise_grace_days`
  u zoni kompanije → fulfilled / partial / broken) i `invoice.overdue` događaji.
- Kursevi: `fx-rates` radnim danima 16:30 UTC (ECB). ECB nema RSD — dev ima DEMO kurseve iz seed-a.
- Demo podaci za preview: `npx tsx scripts/demo-import/import-demo.ts` (uvoz kroz servis uvoza u
  demo tenant; primenjuje ga worker) i `--report` za brojeve poslednjeg uvoza.

## Pravila, šabloni, dokumenti (Sprint 3)

- Pravila: Administracija → Pravila. Standardna politika (D-7 … D+90) se dodaje provisioning-om
  (`provision_receivables_defaults()` → `provision_collection_defaults()`); objava nove verzije =
  zahtev za odobrenje (druga osoba sa `settings.manage`). Dnevni okidači idu posle 06:00 lokalno.
- Šabloni: Administracija → Šabloni; izmena = nova verzija; samo promenljive i tagovi sa bele liste.
- Dokumenti (opomena, IOS): Customer 360 → Dokumenti. Sadržaj je šifrovan u `DOCUMENTS_DIR`
  (Docker: volume `documents` → `/srv/documents` za app i worker; host: `<cwd>/data/documents`;
  e2e `.e2e-data/documents`). Volume NIJE u backup-u baze (BACKLOG: S3 adapter).
- PDF (3.3): worker posle `document.generated` pravi PDF iz istog HTML-a (Chromium iz worker
  image-a, `document_renditions`). Preuzimanje: pregled dokumenta → „Preuzmi PDF" (svrha →
  potpisan link 5 min → `export_log`). Dokument bez PDF-a (npr. iz 3.2): „Napravi PDF".
  Chromium radi kao `node`, bez capability-ja i sa `no-new-privileges`; sopstveni sandbox mu je
  isključen (`--no-sandbox`), jer ga podrazumevani Docker seccomp ne dozvoljava bez root-a
  (`src/server/documents/pdf.ts`).
- Collection mail (3.3): `queue_email` renderuje šablon za primarni kontakt kupca i upisuje ga u
  `mail_outbox` (kind `reminder` / `dunning`, transport `sink` dok nema SMTP-a; demo uvek sink).
  Pregled: `readOutbox()` (sink). Bez kontakta sa email-om: akcija `skipped`, razlog `no_recipient`.
- Dnevni posao odmah: Administracija → Status sistema → „Pokreni dnevni posao sada"
  (`settings.manage`, audit `tenant.daily_requested`; idempotentno — isti dan ne pravi duplikate).
- Predlozi pravila: „Zahteva pažnju" → „Podnesi na odobrenje" → Administracija → Odobrenja
  (druga osoba). Predaja pravnoj: `approval.legal_handover`; ostale odluke: `decision.approve`.
- PDF golden test: `npm run test:pdf` (pokreće naš `pdf.ts` u worker image-u `collect-worker`;
  u `test:db` se preskače dok image nema Chromium).

## Integracije, pošta, rizik (Sprint 4)

- **n8n** (pošta Google Workspace / Microsoft 365 / IMAP-SMTP): postupak u
  `docs/integrations/n8n.md`; šabloni workflow-a u `docs/integrations/n8n/`. Tajna integracije i
  API ključ se prikazuju **jednom** (Administracija → Integracije); u n8n-u idu u env
  (`COLLECT_INBOUND_URL`, `COLLECT_SIGNING_SECRET`, `NODE_FUNCTION_ALLOW_BUILTIN=crypto`).
- Prijem: `POST /api/integrations/{id}/inbound` (potpis + ±5 min). Neuspelo → Administracija →
  Integracije → „Neuspele poruke" → „Pokušaj ponovo". Dnevnik: „Dnevnik sinhronizacije".
- Slanje: pošta naplate tenanta koji nije demo, sa aktivnom integracijom vrste „Pošta" i
  adresom n8n webhook-a, ide kroz n8n (posao `integrations-dispatch`, svaki minut, backoff do
  12 h); demo tenant uvek sink. Vraćena poruka → „Zahteva pažnju".
- Nepovezana primljena pošta: Administracija → Integracije → „Nepovezane poruke" (poveži / zanemari).
- **Rizik:** dnevni posao (06:00 lokalno, i „Pokreni dnevni posao sada") računa ocenu; Customer
  360 → Rizik → „Osveži sada" (`customer.update`). Boja je samo predlog: „Zahteva pažnju" →
  „Podnesi na odobrenje" → druga osoba (`decision.approve` za fizičko lice,
  `approval.risk_override` za pravno lice). Ponderi/pragovi: `tenant_settings.risk_weights`,
  `risk_band_yellow`, `risk_band_red`.
- **CheckPoint:** `CHECKPOINT_API_KEY` u `.env` (dev) / Elestio env panel (staging, prod) za
  servise `app` i `worker`, pa `docker compose up -d app worker`. Do API specifikacije adapter
  vraća `unsupported` (`docs/integrations/checkpoint.md`).

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

## Servisne role (ADR 0005)

Četiri role se prave **jednom po klasteru, kao superuser, PRE migracija 007, 011 i 021**
(migracije bez njih odbijaju rad) — `scripts/create-service-roles.sh` (ranije
`create-worker-role.sh`; poruka u migraciji 007 još pominje staro ime):

| rola             | lozinka (env)          | namena                                                                                   |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `vigor_worker`   | `WORKER_DB_PASSWORD`   | poslovi; politike samo na `domain_events` i `mail_outbox`                                |
| `vigor_backup`   | `BACKUP_DB_PASSWORD`   | `pg_dump`: `pg_read_all_data` + BYPASSRLS, ne piše (osim svog reda u `ops_runs`)         |
| `vigor_restore`  | `RESTORE_DB_PASSWORD`  | restore test: CREATEDB + BYPASSRLS za SVOJU privremenu bazu; podatke glavne baze ne vidi |
| `vigor_renderer` | `RENDERER_DB_PASSWORD` | renderer (S-10): SELECT/UPDATE samo na `render_jobs`; nijedna druga tabela               |

Dev: lozinke i `WORKER_/BACKUP_/RESTORE_DATABASE_URL` u `.env` (generisani, nikad u chat), pa:

```bash
! cd /srv/vigor-collect && ./scripts/create-service-roles.sh && ./scripts/migrate.sh up
```

Staging/prod: na Elestio hostu, sa vrednostima iz vault-a eksportovanim u shell (van Claude
sesije), isti skript (`POSTGRES_USER`/`POSTGRES_PASSWORD` = superuser — samo ovde). Provera:
`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vigor%';` → nijedna
`rolsuper`; `rolbypassrls` samo `vigor_backup` i `vigor_restore`.

Renderer (S-10): servis `renderer` — isti image kao worker, `node renderer.mjs`, jedina rola
`vigor_renderer` (`RENDERER_DB_PASSWORD`), bez volume-a, read-only fajl sistem, `/health` na 3002
unutar mreže. Jedini kontejner u kome se pokreće Chromium.

Pokretanje: servis `worker` u `docker-compose.yml` — Dockerfile stage `worker` (app image +
`postgresql-client-16` + `rclone` + `age`, pinovane verzije), `node worker.mjs`, port nije objavljen,
`/health` na 3001 unutar mreže, volume `backups` → `/srv/backups`. `app` je stage `app` (od 1.5
traži `PII_MASTER_KEYS`, `BETTER_AUTH_*`, `TURNSTILE_*`; lokalno rade Cloudflare-ovi test ključevi).
**Worker image:** kad PGDG objavi noviji 16.x, stari nestaje iz glavnog repoa i build pada —
podići `PG_CLIENT_VERSION` u Dockerfile-u (`apt-cache policy postgresql-client-16`). Isto važi za
Chromium (3.3): `CHROMIUM_VERSION` je build iz `bookworm-security`; kad izađe novi security
update, stari nestaje — podići verziju (`apt-cache policy chromium` u `node:22-bookworm-slim`) i
pustiti `npm run test:pdf`. Lokalno: `npm run build` pa
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

## Security middleware (ADR 0006)

- **Turnstile:** `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` iz Cloudflare panela (Turnstile →
  widget za domen) — vault, van chata. Production bez njih **ne startuje** (log: „Turnstile keys
  are missing"). Dev bez njih: provera se preskače (`turnstile.skipped` u logu).
- **CSP prekršaj** u browseru (konzola „Refused to …") = nova skripta/stil bez nonce-a ili novi
  spoljni domen → izmena u `src/server/security/headers.ts` uz review, nikad `unsafe-inline`.
- **429 `rate_limited`** na `/api/*`: 120 zahteva/min po IP-u (`api_rate_limit`). Iza proksija
  mora stizati pravi `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For …`).

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
- [ ] **BLOKIRAJUĆE:** `scripts/create-service-roles.sh` kao superuser **PRE** migracija 007, 011 i 021 (`vigor_worker`, `vigor_backup`, `vigor_restore`, `vigor_renderer`; bez njih migracije odbijaju rad; runbook „Servisne role").
- [ ] **BLOKIRAJUĆE (S-11):** age par za backup generisan van chata (runbook „Šifrovanje backup-a"): `BACKUP_AGE_RECIPIENT` u env-u worker-a, `BACKUP_AGE_IDENTITY` samo u vault-u i env-u servisa `restore-test`.
- [ ] Servis `renderer` zdrav (`docker compose ps renderer`); PDF dokumenta se generiše (S-10).
- [ ] **Pre prvog staging deploya:** `ALTER TABLE users VALIDATE CONSTRAINT users_auth_user;`
      (kao `vigor_migrate`). Ako padne — postoje viseći `auth_user_id`: očistiti, pa ponoviti.
- [ ] `BETTER_AUTH_URL` je `https://…`; Secure kolačić se ne isključuje nikakvim env flagom.
- [ ] **Turnstile ključevi** (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`) u vault-u i env-u — bez njih production ne startuje (ADR 0006).
- [ ] `scripts/smoke.sh` posle deploya zelen (exit 0).
- [ ] Sentry DSN, kanal za alarme i off-site storage podešeni (Admin → Status sistema: sve „povezan”).
- [ ] Prvi backup (worker) + restore test (`docker compose --profile ops run --rm restore-test`) zeleni (Admin → Status sistema).
- [ ] Release notes + rollback korak zapisani.

## Backup / restore (pravilo 28, zadatak 1.7)

- **Backup:** `scripts/backup.sh` — `pg_dump -Fc` svih baza na koje `vigor_backup` ima CONNECT
  (nikad superuser; `pg_read_all_data` + BYPASSRLS zbog FORCE RLS), role bez lozinki, repo kao
  `git bundle` (u worker image-u nema git-a → bez bundle-a; repo je na GitHub-u); `$BACKUP_DIR/daily/YYYY-MM-DD` (30) i
  `monthly/YYYY-MM` (12). `.env` i ključevi nikad (skripta staje ako je `.env` ili ključ u git-u).
  Rezultat → `ops_runs` (Admin → Status sistema, alarmi).
- **Šifrovanje (S-11):** svaki fajl backup-a (`db-*.dump.age`, `globals.sql.age`,
  `repo.bundle.age`) je šifrovan sa `age` na javni ključ `BACKUP_AGE_RECIPIENT`; `manifest.json`
  nosi samo heševe. Podaci `auth.session` i `auth.verification` (živi tokeni) se ne dump-uju —
  tabele da, prazne. Bez recipient-a backup ne radi (alarm „backup missing").
- **Gde radi:** backup u worker-u (02:00 UTC, `BACKUP_DATABASE_URL` + `BACKUP_AGE_RECIPIENT`).
  **Restore test NIKAD u worker-u** — jedini ima ključ za dešifrovanje: one-shot servis
  `restore-test` (profil `ops`, `RESTORE_DATABASE_URL` + `BACKUP_AGE_IDENTITY`, backups samo za
  čitanje), host cron na Elestio-u nedeljom 03:00 UTC:

  ```bash
  0 3 * * 0  cd /srv/vigor-collect && docker compose --profile ops run --rm restore-test >>/var/log/backup.log 2>&1
  ```

  **Fallback za backup** (worker ne radi): `0 2 * * * cd /srv/vigor-collect && ./scripts/backup.sh`
  sa istim env-om (bez identity-ja).

- **Šifrovanje backup-a — generisanje para** (jednom po okruženju, **van Claude sesije**, na
  admin mašini ili u Elestio terminalu; ključ se nikad ne lepi u chat):

  ```bash
  age-keygen -o backup-age.key            # privatni ključ (AGE-SECRET-KEY-1…)
  age-keygen -y backup-age.key            # javni ključ (age1…) → BACKUP_AGE_RECIPIENT
  ```

  Sadržaj `backup-age.key` (linija `AGE-SECRET-KEY-1…`) ide u vault kao `BACKUP_AGE_IDENTITY` i
  u env servisa `restore-test`; fajl se zatim briše (`shred -u backup-age.key`). Gubitak ključa =
  backup-i su nečitljivi: čuvati ga kao `PII_MASTER_KEYS` (vault, nikad u backup-u). Rotacija:
  nov par → novi `BACKUP_AGE_RECIPIENT`; stari ključ ostaje u vault-u dok postoje backup-i
  šifrovani njim (30 dnevnih / 12 mesečnih).

- **Off-site:** `BACKUP_S3_*` → `rclone sync` iz worker-a; bez `BACKUP_S3_BUCKET` →
  `offsite: not_configured` u `ops_runs` (blokada za staging).
- **Kopija na hostu** (P1, Uroš, 2026-10-13): cron na Elestio hostu u 03:30 (vreme hosta) —
  posle backup-a u 02:00 UTC — `docker cp` kopira backup iz kontejnera u `/opt/app/backups` na
  hostu (`daily/` + `monthly/`); retencija na hostu 30 dana. Tako lokalne kopije preživljavaju
  rekreiranje kontejnera. Crontab je na hostu, nije u repou: proveriti ga posle izmene servera
  (`crontab -l` na hostu) i da `/opt/app/backups` dobija nov dnevni direktorijum. Ovo **nije**
  off-site kopija (isti server) — off-site i dalje ide kroz `BACKUP_S3_*`.
- **Restore test:** `scripts/restore-test.sh` (kao `vigor_restore`) dešifruje poslednji dump glavne
  baze u privremeni fajl (briše se na izlazu), vraća ga u `<db>_restore_test` (`--no-owner`),
  poredi broj redova svake tabele sa dump-om (`auth.session` / `auth.verification` moraju biti
  prazne), briše kopiju, upisuje rezultat. U worker-u odbija da radi (exit 2).
- **Pravi restore (incident):** ključ iz vault-a u fajl van repoa, pa
  `age -d -i <ključ> -o collect.dump db-collect.dump.age && createdb collect_new && pg_restore -d collect_new collect.dump`,
  `shred -u` za ključ i dump; zatim `PII_MASTER_KEYS` iz vault-a (bez ključa šifrovani podaci su
  izgubljeni), promena `DATABASE_URL`. Posle restore-a svi moraju ponovo da se prijave (sesije se
  ne čuvaju u backup-u).

## Preview (dev)

- **URL:** https://vigorcollect-u57586.vm.elestio.app — Elestio nginx (`elestio-nginx`) prosleđuje
  ceo domen na `172.17.0.1:13000` (compose servis `app`). `BETTER_AUTH_URL` u `.env` = taj URL.
- **Iframe:** aplikacija namerno šalje `X-Frame-Options: DENY` + `frame-ancestors 'none'` (ADR 0006,
  odluka (a) 2026-10-12) — Vibecoder preview panel je ne prikazuje; otvarati u posebnom tabu.
- **Konfiguracija proksija** nije ni u jednom git-u: živi fajl je
  `/opt/elestio/nginx/conf.d/vigorcollect-u57586.vm.elestio.app.conf`; kopija je u
  `docs/ops/nginx-preview.conf`. **Vraćanje** (novi server ili izgubljen fajl) — izmeniti POSTOJEĆI
  `.conf` tog domena (nikad novi fajl u `conf.d`, `/opt/app/CLAUDE.md`), prepisati `location /`
  iz kopije (bez prvih 7 redova komentara), pa:

  ```bash
  ! docker exec elestio-nginx nginx -t && docker exec elestio-nginx nginx -s reload
  ! curl -sI https://vigorcollect-u57586.vm.elestio.app/health
  ```

  Očekivano: `HTTP/2 200` i `x-app-version`. Ako je druga mašina, domen u kopiji zameniti `DOMAIN`
  iz `/opt/app/.env`.

- **Pokretanje aplikacije:** `cd /srv/vigor-collect && docker compose up -d app worker` (nikad
  `restart`).
- **Deljenje linka:** NE dok `.env` nema prave Turnstile ključeve (NEXT.md, rizik).

## GitHub

- Remote: `origin` = `git@github.com:udjordjevicagrounik-max/vigorcollect.git` (privatan repo).
  Grane `main` i `develop` prate `origin/*`; push posle svakog merge-a (`git push`, tagovi:
  `git push --tags`).
- Pristup: **deploy key** samo za taj repo (repo → Settings → Deploy keys, „Allow write
  access"). Ključ je `~/.ssh/id_ed25519_github` u dev kontejneru; `~/.ssh/config` ima
  `Host github.com` → `IdentityFile ~/.ssh/id_ed25519_github`, `IdentitiesOnly yes`.
  Provera: `ssh -T git@github.com` → „Hi udjordjevicagrounik-max/vigorcollect! You've
  successfully authenticated".
- Privatni ključ se nikad ne ispisuje, ne kopira u chat ni u repo; deli se samo javni (`.pub`).
- **Ako se dev kontejner rekreira**, `~/.ssh` nestaje zajedno sa ključem (a i repo, ako nije
  push-ovan — zato push posle svakog merge-a). Postupak:
  1. `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N "" -C "vigor-collect-vibecoder"`;
  2. upisati `~/.ssh/config` kao gore;
  3. na GitHub-u obrisati stari deploy key i dodati novi javni ključ (write access);
  4. `git clone git@github.com:udjordjevicagrounik-max/vigorcollect.git /srv/vigor-collect`
     (ili `git remote add origin …` ako repo postoji), pa `ssh -T git@github.com`.
- Kompromitovan ključ (pojavio se u čistom tekstu): odmah obrisati deploy key na GitHub-u, pa
  novi ključ po koracima 1–3.

## Git tok (od zatvaranja Sprinta 1)

`feature/<zadatak>` → `develop` → `release/x.y` → `main`. Claude radi na `feature/*` (grana od
`develop`) i commit-uje tamo; merge radi Uroš `!` komandom (nikad `--no-verify`, hook se vrti):

```bash
# feature gotov → develop
! cd /srv/vigor-collect && git checkout develop && git merge --no-ff feature/<zadatak> -m "chore: merge feature/<zadatak> into develop" && git branch -d feature/<zadatak>
# release (posle security review-a i release checkliste)
! cd /srv/vigor-collect && git checkout -b release/x.y develop && npm test && npm run test:db && npm run build
! cd /srv/vigor-collect && git checkout main && git merge --no-ff release/x.y -m "chore: release x.y" && git tag -a vx.y -m "release x.y" && git checkout develop && git merge --no-ff release/x.y -m "chore: merge release/x.y back into develop"
```

Zaštićeni fajlovi (pravilo 13) i dalje idu u Uroševu `!` komandu na `feature/*` grani.
Poruke merge commit-a prolaze commitlint: tip mora biti iz liste (`chore: merge …`,
`chore: release x.y`) — `merge:` / `release:` hook odbija; verzija je u git tagu.

## Sentry i alarmi (zadatak 1.7)

- `SENTRY_DSN` (app + worker): greške sa tagom `request_id`, `release` = verzija; PII se čisti pre
  slanja (ključevi iz `pii_field_registry` + email/dugi brojevi/IBAN u tekstu). Bez DSN → isključen.
- Alarmi (worker, svakih 5 min): backup nije gotov do 06:00 po zoni tenanta #0, neuspeli poslovi,
  pending stariji od 15 min, health crven 2× zaredom, neuspešan restore test. Telegram
  (`ALERT_TELEGRAM_*`) i/ili Slack (`ALERT_SLACK_WEBHOOK_URL`); bez njih samo log (`"event":"alert"`).
  Isti alarm najviše jednom na sat dok traje.

## Smoke posle deploya

`SMOKE_TENANT_ID=<tenant> ./scripts/smoke.sh https://<domen>` → `/health`, `/login`, upit po tenantu
(RLS), worker heartbeat. Exit ≠ 0 = rollback po release checklisti.
