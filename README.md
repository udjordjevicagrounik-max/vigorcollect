# vigor-collect

Multi-tenant B2B platforma za rizik i naplatu potraživanja. Ime proizvoda nije u kodu —
dolazi iz `PRODUCT_NAME` (pravilo 21). Pravila rada: [`CLAUDE.md`](CLAUDE.md).
Aktivan zadatak: [`docs/NEXT.md`](docs/NEXT.md). Stack i odluke: [`docs/adr/`](docs/adr/).

## Preduslovi

- Node.js iz `.nvmrc` (`nvm use`) — ista verzija je u `package.json` `engines` i `Dockerfile`-u
- Docker + Docker Compose v2
- Sistemski alati za git hook-ove (hook ne sme da se zaobilazi): `psql` 16, `gitleaks`, `semgrep`.
  Instalira ih `scripts/setup-tools.sh` (idempotentno — instalira samo ono što fali).

## Onboarding

```bash
# 0. sistemski alati — PRVI KORAK SVAKE SESIJE (dev kontejner je prolazan, alati mogu da nestanu)
sudo ./scripts/setup-tools.sh

# 1. clone
git clone <repo-url> vigor-collect && cd vigor-collect
nvm use
npm ci                       # instalira i lefthook hook-ove (prepare)

# 2. env — popuni vrednosti (lozinke generiši: openssl rand -hex 16)
cp .env.example .env
$EDITOR .env

# 3. baza
docker compose up -d db      # prvi start kreira vigor_app i vigor_migrate (db/init/01-roles.sh)

# 4. migracije (psql kao vigor_migrate)
npm run migrate              # = ./scripts/migrate.sh up
./scripts/migrate.sh status

# 5. demo podaci (deterministički, samo generisani — pravilo 24)
npm run seed

# 6. razvoj
npm run dev                  # http://localhost:3000, /health

# 7. testovi
npm test                     # Vitest: smoke, golden, unit
npx playwright install chromium   # jednom
npm run test:e2e             # Playwright: 375 px + desktop, na production build-u
```

## Komande

| Komanda                         | Šta radi                                                            |
| ------------------------------- | ------------------------------------------------------------------- |
| `npm run lint`                  | ESLint (uklj. `no-literal-string`, zabrana hex boja u komponentama) |
| `npm run typecheck`             | `tsc --noEmit`                                                      |
| `npm test`                      | Vitest                                                              |
| `npm run test:e2e`              | Playwright                                                          |
| `npm run migrate`               | primena `db/migrations/NNN_<naziv>_up.sql` kroz psql                |
| `./scripts/migrate.sh down NNN` | vraća samo poslednju migraciju (samo dev baza)                      |
| `./scripts/verify-tenant.sh`    | provera tenant izolacije (stub do 1.6)                              |
| `./scripts/rls-drift-check.sh`  | RLS drift (stub do 1.6)                                             |
| `docker compose up -d app`      | deploy app-a (nikad `restart`)                                      |

## Git hook-ovi (lefthook)

`pre-commit`: lint → typecheck → gitleaks → semgrep → verify-tenant → rls-drift → vitest → npm audit.
`commit-msg`: commitlint (conventional commits — CHANGELOG se generiše iz njih).
Ako hook padne: ne commit-uj, popravi. `--no-verify` se ne koristi.

## Napomene za okruženje

- Ako je u okruženju `NODE_ENV=production`, `.npmrc` (`include=dev`) obezbeđuje da se dev
  zavisnosti ipak instaliraju.
- Dev kontejner izvozi `PIP_TARGET` / `PYTHONPATH` za sopstvene Python zavisnosti; zato
  `setup-tools.sh` instalira semgrep kroz pipx sa očišćenim pip okruženjem, a hook ga pokreće
  sa `env -u PYTHONPATH`.
- Na Elestio dev serveru postavi `DB_BIND_HOST=172.17.0.1` i `POSTGRES_PORT=15432` u `.env`
  (dev kontejner ne vidi host-ov `127.0.0.1`). Nikad `0.0.0.0`.

## Zaštićeni fajlovi (pravilo 13)

`docker-compose.yml`, `db/migrations/*`, `db/init/*`, `db/Dockerfile`, `src/server/auth/*`,
`src/server/tenant/*`, `CODEOWNERS`, `CLAUDE.md` — Claude predlaže, vlasnik pregleda i commit-uje.
