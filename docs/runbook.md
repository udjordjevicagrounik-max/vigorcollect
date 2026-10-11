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

## DB uloge na Elestio (staging/prod)

Lokalno ih kreira `db/init/01-roles.sh`. Na Elestio instanci izvršiti iste naredbe ručno kao
superuser (jednom po instanci), sa lozinkama iz vault-a — nikad iz repoa.
Provera: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vigor%';`
→ oba reda moraju imati `f`, `f`.

## Deploy

`docker compose up -d app` — nikad `restart` (diže stari image).
Posle deploya: smoke (`/health` 200 + `X-App-Version` = očekivani tag).

## Backup / restore

TODO(1.6): `scripts/backup.sh`, restore test (baza + fajlovi).
