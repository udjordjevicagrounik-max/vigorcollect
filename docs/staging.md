# Staging — Elestio instanca #2 (Sprint 6.5)

Staging je druga Elestio instanca, odvojena od dev servera: sopstvena baza, sopstveni ključevi,
sopstveni domen. Isti `docker-compose.yml` kao dev; razlika je samo u env-u. **Nijedna vrednost
iz ovog dokumenta ne ide u chat, repo ili log** (pravilo 9) — sve tajne žive u vault-u i u
Elestio env panelu instance.

Redosled je obavezan: **servisne role → migracije → aplikacija → smoke**. Migracije 007, 011 i 021
odbijaju rad bez servisnih rola.

## 0. Šta treba pre početka

- [ ] Elestio instanca #2 (Docker Compose šablon, ≥ 4 GB RAM, Ubuntu LTS), SSH pristup.
- [ ] Domen za staging (npr. `staging.<domen>`) sa A zapisom na IP instance.
- [ ] Vault (1Password / Bitwarden) sa novom sekcijom „staging" — vrednosti iz koraka 2.
- [ ] Cloudflare Turnstile widget za staging domen (site key + secret).
- [ ] Sentry projekat (ili env `staging` u postojećem) i kanal za alarme (Telegram / Slack).
- [ ] S3-kompatibilan bucket za off-site backup (posebna putanja `staging/`).

## 1. Kod na instanci

```bash
ssh <staging-host>
sudo mkdir -p /srv/vigor-collect && sudo chown "$USER" /srv/vigor-collect
git clone git@github.com:<org>/vigor-collect.git /srv/vigor-collect
cd /srv/vigor-collect && git checkout v0.1.0      # tag iz scripts/release.sh, nikad develop
```

## 2. Env (vault → `.env` na instanci)

`.env` se pravi **na instanci**, ručno iz vault-a (ili Elestio env panel), po `.env.example`.
Generisanje novih vrednosti — na instanci, van Claude sesije; izlaz ide direktno u vault:

```bash
openssl rand -base64 32                       # BETTER_AUTH_SECRET, *_DB_PASSWORD
printf '1:%s\n' "$(openssl rand -base64 32)"  # PII_MASTER_KEYS (vault + papirna kopija, runbook)
age-keygen                                    # BACKUP_AGE_RECIPIENT (env) / IDENTITY (samo vault)
```

| promenljiva                                                   | staging vrednost / izvor                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PRODUCT_NAME`                                                | radno ime dok ime proizvoda nije odlučeno                             |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`           | nove (vault); superuser samo za bootstrap i korak 3                   |
| `DB_BIND_HOST`                                                | `127.0.0.1` (nikad `0.0.0.0`)                                         |
| `APP_DB_PASSWORD`, `MIGRATE_DB_PASSWORD`                      | nove (vault)                                                          |
| `WORKER_`, `BACKUP_`, `RESTORE_`, `RENDERER_DB_PASSWORD`      | nove (vault)                                                          |
| `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `WORKER_DATABASE_URL` | host `127.0.0.1`, role `vigor_app` / `vigor_migrate` / `vigor_worker` |
| `BACKUP_DATABASE_URL`, `RESTORE_DATABASE_URL`                 | role `vigor_backup` / `vigor_restore`                                 |
| `PII_MASTER_KEYS`                                             | **nov** ključ (nikad dev ključ; runbook „PII master ključ")           |
| `BETTER_AUTH_SECRET`                                          | nov                                                                   |
| `BETTER_AUTH_URL`                                             | `https://staging.<domen>`                                             |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`                      | staging widget (bez njih production ne startuje)                      |
| `TRUSTED_PROXY_HOPS`                                          | `1` (Elestio nginx); `2` ako je ispred i Cloudflare proxy             |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`                            | DSN iz vault-a, `staging`                                             |
| `ALERT_TELEGRAM_*` / `ALERT_SLACK_WEBHOOK_URL`                | staging kanal                                                         |
| `BACKUP_AGE_RECIPIENT`                                        | javni ključ (age1…)                                                   |
| `BACKUP_AGE_IDENTITY`                                         | **samo** env servisa `restore-test` (vault)                           |
| `BACKUP_S3_*`                                                 | bucket + prefiks `staging/`                                           |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`                            | Azure app sa staging redirect URL-om (opciono)                        |
| `CHECKPOINT_API_KEY`                                          | opciono                                                               |
| `SMOKE_TENANT_ID`                                             | posle koraka 6 (tenant #0)                                            |
| `SEED_ADMIN_PASSWORD`, `MAILBOX_ALLOW_PRIVATE_HOSTS`          | **prazno** na staging-u                                               |

Provera bez štampanja vrednosti: `grep -c '=$' .env` → samo opcione promenljive su prazne.

## 3. Baza i servisne role (jednom po instanci)

```bash
docker compose up -d db
# vrednosti iz vault-a eksportovane u shell (POSTGRES_USER / POSTGRES_PASSWORD = superuser)
./scripts/create-service-roles.sh
```

Provera: `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'vigor%';` →
nijedna `rolsuper`; `rolbypassrls` samo `vigor_backup` i `vigor_restore`.

## 4. Migracije (ops profil, one-shot)

```bash
./scripts/migrate.sh up        # bez MIGRATE_DATABASE_URL u shell-u → one-shot servis `migrate`
./scripts/migrate.sh status    # sve primenjene, nijedna pending
```

Kao `vigor_migrate` posle prve migracije (release checklist):
`ALTER TABLE users VALIDATE CONSTRAINT users_auth_user;`

## 5. Aplikacija

```bash
APP_VERSION=v0.1.0 docker compose up -d --build app worker renderer
docker compose ps        # app, worker, renderer: healthy
```

Nginx (Elestio): `staging.<domen>` → `127.0.0.1:${APP_PORT}`; `X-Forwarded-For` se prosleđuje.

## 6. Tenant #0 (platforma) i prvi korisnik

Tenant #0 (Sinergista, `is_platform_operator`) i njegov owner se prave seed-om tenanta #0
(runbook „Prvi login admina"), bez demo podataka. Owner #0 dobija pozivnicu; prijava + TOTP.
Posle toga: Platforma → Tenanti → Novi tenant (Agrounik kao **trial**, `contract_signed_at`
prazno → mejl samo u sink dok ugovor nije potpisan).

## 7. Smoke

```bash
SMOKE_TENANT_ID=<tenant #0> WORKER_HEALTH_URL=http://127.0.0.1:3001/health \
  ./scripts/smoke.sh https://staging.<domen>
```

Exit 0 = staging je gotov. Exit ≠ 0 → `docker compose logs app worker --since 10m`, pa rollback
(sledeća sekcija).

## 8. Posle prvog deploya

- [ ] Prvi backup + restore test: `docker compose --profile ops run --rm restore-test`.
- [ ] Admin → Status sistema: Sentry, alarmi, off-site — sve „povezan".
- [ ] Turnstile radi na `/login`, `/signup`, `/onboarding/<token>`.
- [ ] Platformski flag `signup.pipedrive_lead` ostaje isključen dok n8n workflow ne prođe test.

## Rollback

Aplikacija: `git checkout <prethodni tag>` pa `docker compose up -d --build app worker renderer`.
Migracije se ne vraćaju na staging-u bez razloga; ako mora — `migrate down <NNN>` samo za
migracije iz tog release-a, posle backup-a (runbook „Backup / restore").
