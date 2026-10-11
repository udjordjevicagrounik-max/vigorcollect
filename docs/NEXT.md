# NEXT

## Aktivan zadatak

**0.2 Schema v1** — prva poslovna migracija (`001_*_up.sql` / `001_*_down.sql`) prema
`docs/schema-v1.md` (dokument se kreira u 0.2), sa RLS politikom na svakoj tabeli sa `tenant_id`,
`feature_flags` (platformski + tenant nivo, pravilo 31).

**Prava za 0.2:** `db/init/01-roles.sh` postavlja `ALTER DEFAULT PRIVILEGES FOR ROLE vigor_migrate
IN SCHEMA public` → `vigor_app` automatski dobija `SELECT, INSERT, UPDATE, DELETE` na novim
tabelama i `USAGE, SELECT` na sekvencama. Per-table `GRANT`/`REVOKE` u migraciji je dozvoljen,
nije obavezan — ali **jeste obavezan `REVOKE` tamo gde app ne sme da piše**: `audit_log`
(`REVOKE UPDATE, DELETE`, pored triggera — pravilo 6), platformske tabele bez `tenant_id`
(kao `schema_migrations` u 000). RLS i dalje filtrira svaki red. Na Elestio staging/prod iste
`ALTER DEFAULT PRIVILEGES` naredbe se izvršavaju ručno (runbook).

## Poslednja sesija — 0.1 Bootstrap skeleta (2026-10-11)

### Urađeno

- Next.js 16 (App Router, `output: standalone`) + TypeScript 6 strict, PWA manifest (`/manifest.webmanifest`).
- Zavisnosti: next, react, next-intl, zod, drizzle-orm, pg, pg-boss, better-auth (bez konfiguracije);
  dev: tailwindcss 4, eslint 9 + typescript-eslint + react-hooks + i18next, prettier, vitest,
  playwright, lefthook, commitlint, tsx. `npm audit --audit-level=high` = 0.
- Struktura po CLAUDE.md (README u praznim folderima), bez `src/server/settlement`.
- Wimbledon tokeni: `src/styles/tokens.css` (jedino mesto sa hex vrednostima) + `tailwind.config.ts`
  kroz `@config`; Inter 400/500/600. Lint + semgrep zabranjuju hex u `src/app` i `src/components`.
- i18n: `messages/sr-Latn.json` (izvor) + `en.json`; test proverava iste ključeve;
  ESLint `i18next/no-literal-string` (mode `jsx-only`) aktivan.
- Shell: nav grupe Work / Intelligence / Admin; **Resolution se ne renderuje** dok su svi
  `settlement.*` flagovi isključeni (stub `src/lib/feature-flags.ts`). Prazno stanje sa akcijom,
  `error.tsx` sa `X-Request-Id`, `not-found`. Mobile klasa kroz `<Screen mobileClass=…>`.
- `src/proxy.ts` (Next 16 naziv za middleware): `X-Request-Id` + `X-App-Version` na svaki odgovor.
- `/health` → 200 `{status:"ok"}`.
- DB sloj: `src/db/env.ts` (Zod) + `src/db/client.ts` (dva pool-a: vigor_app / vigor_migrate).
- `scripts/migrate.sh` (up / status / down poslednje; checksum; jedna transakcija po migraciji).
- Stub skripte: `verify-tenant.sh` (već radi statičku proveru pravila 2), `rls-drift-check.sh`,
  `backup.sh`, `seed-demo.ts` (deterministički PRNG + `daysFromToday`).
- Hook-ovi: lefthook pre-commit (lint, tsc, gitleaks, semgrep, verify-tenant, rls-drift, vitest,
  npm audit) + commit-msg (commitlint). `.semgrep.yml` sa 6 pravila.
- Testovi: Vitest 9/9 (smoke /health + proxy header-i, golden RLS coverage + self-check,
  tokeni, i18n ključevi); Playwright 14/14 (375 px + desktop: header-i, nav bez Resolution,
  prazno stanje, bez horizontalnog overflow-a, locale, 404).
- Docs: ADR 0000 + 0001, BACKLOG, permissions (prazna matrica + javne rute), security checklist, runbook, README.
- Lokalno verifikovano: compose `db` diže obe uloge (rolsuper = f, rolbypassrls = f), `migrate.sh`
  up/status/down/up, `vigor_app` čita ali ne briše `schema_migrations`, `next build` prolazi.

### Nije urađeno / čeka

- **Zaštićeni fajlovi — predlog, NIJE commit-ovano (pravilo 13):** `docker-compose.yml`,
  `db/Dockerfile`, `db/.dockerignore`, `db/init/01-roles.sh`, `db/migrations/000_init_{up,down}.sql`,
  `CODEOWNERS`, `src/server/auth/README.md`. Uroš pregleda i commit-uje.
- `CODEOWNERS` ima `@OWNER` umesto GitHub handle-a.
- DB provere u `verify-tenant.sh` / `rls-drift-check.sh`, `backup.sh`, seed sadržaj → 1.6.
- Auth ekrani → 1.3. AI adapter → zaseban zadatak.

### Odluke (vidi ADR 0001)

- `proxy.ts` umesto `middleware.ts` (Next 16).
- Bez `eslint-config-next` (high advisory bez ispravke u lancu `braces`); bez `server-only` (pravilo 14).
- `.npmrc include=dev` jer server ima `NODE_ENV=production`.
- DB init se kopira u image (`db/Dockerfile`) jer Docker daemon ne vidi putanju repoa.
- `ALTER DEFAULT PRIVILEGES` za `vigor_app` (DML na tabelama, usage na sekvencama);
  `000_init_up.sql` eksplicitno oduzima pisanje u `schema_migrations`.
- `scripts/setup-tools.sh`: psql 16 (PGDG), semgrep (pipx, čisto pip okruženje), gitleaks
  (poslednja stabilna) + symlink-ovi u `/usr/local/bin`. Prvi korak svake sesije (runbook).
- Runtime Docker stage nosi samo standalone output (proveren image: nema eslint/typescript/vitest…).

## Rizik

- **Dev kontejner postavlja `PIP_TARGET=/opt/app/data/.python-deps` i `PYTHONPATH` na isto.**
  Prvi pokušaj instalacije semgrep-a je zbog toga upisao Python pakete u `/opt/app/data/`
  (direktorijum nije postojao pre toga). Bezbednosna provera nije dozvolila Claude-u brisanje
  u `/opt/app` — Uroš briše ručno: `rm -rf /opt/app/data`. Na `/opt/app` ništa drugo nije menjano.

- **Docker daemon ≠ ovaj kontejner.** Bind mount-ovi iz `/srv/vigor-collect` na serveru ne rade
  (daemon vidi drugi fajl sistem). Sve što ide u kontejner mora kroz build context.
  Portovi: `DB_BIND_HOST=172.17.0.1`, `POSTGRES_PORT=15432` u lokalnom `.env`.
- Golden RLS test je statički (regex nad SQL-om); složene politike (npr. `ALTER POLICY`,
  `FORCE ROW LEVEL SECURITY`) prepoznaje tek 1.6 kroz proveru žive baze.
- Next major verzije menjaju konvencije; ESLint radi bez Next-specifičnih pravila do ispravke advisory-ja.
- `npm audit` u hook-u zavisi od mreže — offline commit neće proći.

## Otvorena pitanja

- GitHub handle za `CODEOWNERS`?
- Remote repo (GitHub/GitLab) i grane `develop` / `release/*` — kada?
