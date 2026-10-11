# 0001 — Aplikacioni stack

- **Status:** prihvaćeno
- **Datum:** 2026-10-11
- **Donosilac:** Uroš
- **Povezano:** zadatak 0.1, CLAUDE.md „Projekat", pravila 3, 4, 14, 16, 17, 21, 23, 25, 26

## Kontekst

Multi-tenant B2B SaaS koji razvija jedna osoba uz Claude Code. Potreban je jedan jezik
(TypeScript) od baze do UI-ja, RLS u Postgresu kao primarna tenant izolacija, PWA za mobilni
rad i i18n od prvog dana (sr-Latn izvor, en default). Deploy: Elestio (staging + prod).

## Odluka

| Sloj         | Izbor (verzija u 0.1)                                                                     | Zašto                                                                           |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Runtime      | Node.js 22.23.3 (`.nvmrc`, `engines`, `Dockerfile` — ista verzija)                        | LTS; jedan izvor istine za verziju                                              |
| Web          | Next.js 16 App Router, React 19, `output: standalone`                                     | SSR + route handlers u jednom procesu; mali Docker image                        |
| Jezik        | TypeScript 6, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`        | TS 7 (native) još nije podržan u typescript-eslint                              |
| Baza         | PostgreSQL 16, dve uloge `vigor_app` / `vigor_migrate`                                    | RLS; aplikacija bez BYPASSRLS (pravilo 3)                                       |
| Pristup bazi | `pg` + Drizzle ORM **samo kao query builder**                                             | tipizovani upiti bez generisanja šeme; `drizzle-kit push` zabranjen (pravilo 4) |
| Migracije    | ručni SQL + `scripts/migrate.sh` (psql, `schema_migrations` sa checksum-om)               | migracija je pregledljiv artefakt; primenjena migracija je nepromenljiva        |
| Jobovi       | pg-boss                                                                                   | redovi u istom Postgresu — bez Redis-a, transakciono uz `domain_events` outbox  |
| Auth         | Better Auth (instaliran u 0.1, konfiguracija u 1.3)                                       | ne pišemo sopstveni auth (pravilo 10)                                           |
| Validacija   | Zod 4                                                                                     | ulaz, env i AI izlaz kroz istu biblioteku (pravila 8, 22)                       |
| i18n         | next-intl, locale iz cookie-ja / Accept-Language, **bez URL prefiksa**                    | jezik zavisi od korisnika i tenanta (1.3), ne od URL-a                          |
| Stil         | Tailwind CSS 4 + `tailwind.config.ts` kroz `@config`; vrednosti u `src/styles/tokens.css` | semantički tokeni (CLAUDE.md „Design tokeni")                                   |
| Testovi      | Vitest (unit/smoke/golden), Playwright (e2e, 375 px + desktop)                            | brzi testovi u hook-u, e2e pre release-a                                        |
| Kvalitet     | ESLint 9 (typescript-eslint strict, react-hooks, i18next `no-literal-string`), Prettier   |                                                                                 |
| Hook-ovi     | lefthook + commitlint (conventional)                                                      | jedan YAML, bez npm skripti u `.husky/`                                         |
| Bezbednost   | gitleaks, semgrep (`.semgrep.yml`), `npm audit --audit-level=high`                        | sistemski alati, nisu npm zavisnosti                                            |

**Tailwind: `@config` umesto `@theme`.** Sirove vrednosti boja žive isključivo u `tokens.css`
kao CSS promenljive (da bi dark mode kasnije bio samo zamena tog bloka), a `tailwind.config.ts`
je registar semantičkih imena koji CLAUDE.md eksplicitno traži — `@theme` bi definisao boje
drugi put u CSS-u i razdvojio izvor istine, zato se ne prelazi na `@theme` bez novog ADR-a.

## Odstupanja od plana i zašto

- **`src/proxy.ts` umesto `middleware.ts`.** Next 16 je preimenovao konvenciju (`middleware`
  je deprecated). Uloga je ista: svaki odgovor dobija `X-Request-Id` i `X-App-Version`.
- **Bez `eslint-config-next`.** Njegov lanac `fast-glob → micromatch → braces` ima high
  advisory bez ispravke, pa bi `npm audit --audit-level=high` u hook-u stalno padao. Umesto njega:
  `@eslint/js` + `typescript-eslint` + `eslint-plugin-react-hooks`. Gubimo Next-specifična lint
  pravila (npr. `no-html-link-for-pages`) — vratiti kad advisory bude zatvoren (BACKLOG).
- **Bez `server-only`.** Paket nije ažuriran od 2022 (pravilo 14).
- **`.npmrc` ima `include=dev`.** Server ima `NODE_ENV=production` u okruženju, pa bi npm
  inače tiho preskočio dev zavisnosti (eslint, tsc, vitest…).
- **DB init skripta se kopira u image (`db/Dockerfile`), ne bind-mount-uje.** Docker daemon
  na serveru ne vidi putanju repoa; build context radi svuda.

## Razmotrene alternative

| Alternativa                 | Zašto ne                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| Prisma                      | generiše i migrira šemu; sukob sa ručnim SQL migracijama i RLS-om         |
| `drizzle-kit` migracije     | `push` predlaže brisanje živih tabela (pravilo 4)                         |
| Keycloak umesto Better Auth | dodatni servis za održavanje; ostaje opcija ako zatreba SSO za enterprise |
| BullMQ + Redis              | dodatna infrastruktura; pg-boss je transakcioni sa outbox-om              |
| husky                       | lefthook podržava piped korake i jedan YAML bez dodatnih fajlova          |
| Locale u URL-u (`/en/...`)  | jezik dolazi iz `users.locale` / tenanta; URL prefiks bi dupliran izvor   |

## Posledice

- **Pozitivne:** jedan jezik, RLS kao tvrda granica, mali broj servisa (app + Postgres).
- **Negativne / rizici:** Next major verzije menjaju konvencije (već jednom: proxy);
  bez Next lint pravila dok se advisory ne zatvori; migracije zahtevaju disciplinu (nema auto-diff-a).
- **Ne menjati bez novog ADR-a:** dve DB uloge, ručne SQL migracije, `@config` + `tokens.css`,
  i18n bez URL prefiksa, Node verzija na tri mesta istovremeno.
