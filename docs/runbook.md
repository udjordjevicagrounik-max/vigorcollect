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

Generisanje (jednom po okruženju — dev, staging, prod imaju RAZLIČITE ključeve):

```bash
! cd /srv/vigor-collect && grep -q '^PII_MASTER_KEYS=.' .env || echo "PII_MASTER_KEYS=1:$(openssl rand -base64 32)" >> .env
```

- Format: `verzija:base64(32 bajta)`, više verzija odvojeno zarezom; najviša šifruje nove ključeve.
- Staging/prod: vrednost ide u vault (dve nezavisne kopije), pa u okruženje instance — **ne** u
  backup baze. Restore baze bez ovog ključa = nečitljiv PII.
- Rotacija: dodati `N+1:<novi>`; stari ostaje dok re-wrap job ne prijavi 0 redova (ADR 0003).
- Gubitak ključa je nepovratan za sve P1–P3 podatke.

## DB uloge na Elestio (staging/prod)

Lokalno ih kreira `db/init/01-roles.sh`. Na Elestio instanci izvršiti iste naredbe ručno kao
superuser (jednom po instanci), sa lozinkama iz vault-a — nikad iz repoa.
Provera: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vigor%';`
→ oba reda moraju imati `f`, `f`.

## Deploy

`docker compose up -d app` — nikad `restart` (diže stari image).
Posle deploya: smoke (`/health` 200 + `X-App-Version` = očekivani tag).

## Backup / restore

TODO(1.6): `scripts/backup.sh`, restore test (baza + fajlovi + `PII_MASTER_KEYS` iz vault-a,
nikad iz backup-a).
