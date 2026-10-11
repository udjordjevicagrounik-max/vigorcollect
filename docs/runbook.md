# Runbook

_Popunjava se kroz 1.6 (backup/restore) i prvi deploy._

## Početak svake sesije (dev kontejner)

```bash
cd /srv/vigor-collect
./scripts/setup-tools.sh        # 1. psql 16, gitleaks, semgrep — instalira samo što fali
docker compose up -d db         # 2. baza (ako nije podignuta)
./scripts/migrate.sh status     # 3. stanje migracija
cat docs/NEXT.md                # 4. aktivan zadatak
```

Alati žive u ovom kontejneru, ne u repou, i mogu da nestanu posle restarta/rebuild-a kontejnera.
Bez njih pre-commit hook pada — ne zaobilaziti (`--no-verify` je zabranjen).

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
