# Ulaz za security review (odvojena sesija)

Pripremljeno na zatvaranju Sprinta 1 (2026-10-12) za **odvojenu** Claude sesiju koja dobija samo
diff i ovaj spisak (CLAUDE.md: `docs/security-review-checklist.md` pre merge-a u `main`).

- **Opseg:** `03cc604` (chore: add project CLAUDE.md) → `HEAD`. Stanje ispod je za `fb2e325`;
  posle Uroševe `!` komande (migracija 011, compose, Dockerfile) regenerisati:
  `git diff 03cc604..HEAD --stat` i `git diff 03cc604..HEAD -- <fajl>` po potrebi.
- **Ukupno:** 267 files changed, 31657 insertions(+)
- **Checklist:** `docs/security-review-checklist.md`; pravila: CLAUDE.md (38 NON-NEGOTIABLE).

## Fokus (najveći rizik prvo)

1. Tenant izolacija: RLS u svim migracijama, `withTenant()` / `withTenantPage()` / `withTenantJob()`,
   `scopeFilter()`, politike `auth_membership_read`, `invite_token_lookup`, `tenant_clock_read`.
2. Role sa posebnim pravima: `vigor_worker` (samo outbox), `vigor_backup` / `vigor_restore`
   (BYPASSRLS — trigger `ops_runs_kind_by_role`), SECURITY DEFINER funkcije (`tenant_clock`,
   `platform_timezone`, `job_health`).
3. Auth: Better Auth konfiguracija, lockout hook-ovi, captcha, CSRF provere, pozivnice (token heš).
4. Maker-checker: promena role (`user.update` → `user.assign`), matrica (`approval.create` → `role.manage`).
5. PII: šifrovanje (keyring, HKDF za `mail_outbox`), audit redakcija, Sentry/alarm scrubbing, backup sadržaj.

## Zaštićeni fajlovi (pravilo 13) u opsegu

- `CLAUDE.md`
- `CODEOWNERS`
- `db/migrations/000_init_down.sql`
- `db/migrations/000_init_up.sql`
- `db/migrations/001_identity_tenant_governance_down.sql`
- `db/migrations/001_identity_tenant_governance_up.sql`
- `db/migrations/002_customers_subject_keys_down.sql`
- `db/migrations/002_customers_subject_keys_up.sql`
- `db/migrations/003_sharing_governance_down.sql`
- `db/migrations/003_sharing_governance_up.sql`
- `db/migrations/004_permissions_seed_down.sql`
- `db/migrations/004_permissions_seed_up.sql`
- `db/migrations/005_auth_down.sql`
- `db/migrations/005_auth_up.sql`
- `db/migrations/006_invitations_mail_down.sql`
- `db/migrations/006_invitations_mail_up.sql`
- `db/migrations/007_worker_down.sql`
- `db/migrations/007_worker_up.sql`
- `db/migrations/008_api_rate_limit_down.sql`
- `db/migrations/008_api_rate_limit_up.sql`
- `db/migrations/009_teams_down.sql`
- `db/migrations/009_teams_up.sql`
- `db/migrations/010_ops_down.sql`
- `db/migrations/010_ops_up.sql`
- `db/migrations/011_team_permissions_backup_roles_down.sql`
- `db/migrations/011_team_permissions_backup_roles_up.sql`
- `docker-compose.yml`
- `src/server/auth/README.md`
- `src/server/auth/audit.ts`
- `src/server/auth/better-auth.ts`
- `src/server/auth/context.ts`
- `src/server/auth/invitations.ts`
- `src/server/auth/memberships.ts`
- `src/server/auth/permissions.ts`
- `src/server/auth/scope.ts`
- `src/server/auth/session.ts`
- `src/server/auth/with-tenant.ts`

## ADR-ovi

- `docs/adr/0001-stack.md` — 0001 — Aplikacioni stack
- `docs/adr/0002-canonical-party-model.md` — 0002 — Kanonski model stranaka, tenant osnova i governance (Schema v1, 0.2a)
- `docs/adr/0003-pii-encryption.md` — 0003 — Šifrovanje PII: subject_keys, envelope, blind index po tenantu
- `docs/adr/0004-auth.md` — 0004 — Autentifikacija: Better Auth u šemi `auth`, lozinka + TOTP, sesija vezana za tenant
- `docs/adr/0005-worker.md` — 0005 — Worker: outbox, pg-boss i zakazani job-ovi
- `docs/adr/0006-security-middleware.md` — 0006 — Security middleware: headeri, CSRF, Zod, rate limit, Turnstile, oblik greške

## `git diff 03cc604..HEAD --stat` (fb2e325)

```text
 .dockerignore                                      |   10 +
 .env.example                                       |   78 +
 .gitignore                                         |   26 +
 .npmrc                                             |    3 +
 .nvmrc                                             |    1 +
 .prettierignore                                    |    6 +
 .prettierrc.json                                   |    6 +
 .semgrep.yml                                       |   50 +
 CODEOWNERS                                         |    9 +
 Dockerfile                                         |   32 +
 README.md                                          |   86 +
 commitlint.config.mjs                              |    4 +
 db/.dockerignore                                   |    2 +
 db/Dockerfile                                      |    5 +
 db/init/01-roles.sh                                |   35 +
 db/migrations/000_init_down.sql                    |    6 +
 db/migrations/000_init_up.sql                      |   19 +
 .../001_identity_tenant_governance_down.sql        |   33 +
 .../001_identity_tenant_governance_up.sql          |  558 ++
 db/migrations/002_customers_subject_keys_down.sql  |   23 +
 db/migrations/002_customers_subject_keys_up.sql    |  298 +
 db/migrations/003_sharing_governance_down.sql      |   32 +
 db/migrations/003_sharing_governance_up.sql        |  497 +
 db/migrations/004_permissions_seed_down.sql        |   80 +
 db/migrations/004_permissions_seed_up.sql          |   68 +
 db/migrations/005_auth_down.sql                    |   18 +
 db/migrations/005_auth_up.sql                      |  182 +
 db/migrations/006_invitations_mail_down.sql        |   15 +
 db/migrations/006_invitations_mail_up.sql          |  176 +
 db/migrations/007_worker_down.sql                  |   43 +
 db/migrations/007_worker_up.sql                    |  156 +
 db/migrations/008_api_rate_limit_down.sql          |    5 +
 db/migrations/008_api_rate_limit_up.sql            |   51 +
 db/migrations/009_teams_down.sql                   |   12 +
 db/migrations/009_teams_up.sql                     |   75 +
 db/migrations/010_ops_down.sql                     |    5 +
 db/migrations/010_ops_up.sql                       |   57 +
 docker-compose.yml                                 |  121 +
 docs/BACKLOG.md                                    |  148 +
 docs/NEXT.md                                       |  163 +
 docs/adr/0000-template.md                          |   32 +
 docs/adr/0001-stack.md                             |   70 +
 docs/adr/0002-canonical-party-model.md             |  106 +
 docs/adr/0003-pii-encryption.md                    |  119 +
 docs/adr/0004-auth.md                              |  113 +
 docs/adr/0005-worker.md                            |   65 +
 docs/adr/0006-security-middleware.md               |   47 +
 docs/legal/.gitkeep                                |    0
 docs/permissions.md                                |  142 +
 docs/runbook.md                                    |  236 +
 docs/schema-v1.md                                  |   87 +
 docs/security-review-checklist.md                  |   52 +
 docs/wireframes/admin-users.html                   |   81 +
 docs/wireframes/case.html                          |  139 +
 docs/wireframes/customer-360.html                  |  120 +
 docs/wireframes/dashboard.html                     |  105 +
 docs/wireframes/import.html                        |  111 +
 docs/wireframes/wireframe.css                      |  193 +
 docs/wireframes/wireframe.js                       |   44 +
 eslint.config.mjs                                  |  114 +
 lefthook.yml                                       |   29 +
 messages/en.json                                   |  333 +
 messages/sr-Latn.json                              |  333 +
 next.config.ts                                     |   12 +
 package-lock.json                                  | 9723 ++++++++++++++++++++
 package.json                                       |   58 +
 playwright.config.ts                               |   69 +
 postcss.config.mjs                                 |    7 +
 public/.gitkeep                                    |    0
 public/icons/icon-192.png                          |  Bin 0 -> 721 bytes
 public/icons/icon-512.png                          |  Bin 0 -> 2300 bytes
 scripts/backup.sh                                  |  112 +
 scripts/copy-standalone-assets.mjs                 |   11 +
 scripts/create-worker-role.sh                      |   36 +
 scripts/dev-admin-password.ts                      |   89 +
 scripts/generate-icons.ts                          |   64 +
 scripts/lib/dev-guard.ts                           |   41 +
 scripts/lib/env.sh                                 |   31 +
 scripts/lib/pg-admin.sh                            |   39 +
 scripts/migrate.sh                                 |   96 +
 scripts/restore-test.sh                            |   64 +
 scripts/rls-drift-check.sh                         |   16 +
 scripts/seed-demo.ts                               |  502 +
 scripts/setup-test-db.sh                           |   43 +
 scripts/setup-tools.sh                             |   79 +
 scripts/smoke.sh                                   |   63 +
 scripts/test-db.sh                                 |   30 +
 scripts/verify-tenant.sh                           |   20 +
 scripts/worker-entry.mjs                           |    7 +
 src/app/(app)/admin/approvals/page.tsx             |   41 +
 src/app/(app)/admin/settings/page.tsx              |   34 +
 src/app/(app)/admin/status/page.tsx                |  140 +
 src/app/(app)/admin/teams/page.tsx                 |   40 +
 src/app/(app)/admin/users/page.tsx                 |   40 +
 src/app/(app)/import/page.tsx                      |   20 +
 src/app/(app)/layout.tsx                           |   67 +
 src/app/(app)/page.tsx                             |   19 +
 src/app/(app)/settings/password/page.tsx           |   17 +
 src/app/(auth)/invite/[token]/page.tsx             |   94 +
 src/app/(auth)/layout.tsx                          |   11 +
 src/app/(auth)/login/mfa/page.tsx                  |   16 +
 src/app/(auth)/login/page.tsx                      |   23 +
 src/app/(auth)/select-tenant/page.tsx              |   45 +
 src/app/(auth)/settings/mfa-setup/page.tsx         |   19 +
 src/app/api/approvals/[id]/decision/route.ts       |   19 +
 src/app/api/approvals/route.ts                     |   13 +
 src/app/api/auth/[...all]/route.ts                 |   13 +
 src/app/api/customers/[id]/route.ts                |   16 +
 src/app/api/customers/route.ts                     |   11 +
 src/app/api/invitations/[id]/revoke/route.ts       |   50 +
 src/app/api/invitations/accept/route.ts            |   73 +
 src/app/api/invitations/route.ts                   |   36 +
 src/app/api/settings/tenant/route.ts               |   12 +
 src/app/api/teams/[id]/lead/route.ts               |   17 +
 src/app/api/teams/[id]/members/remove/route.ts     |   16 +
 src/app/api/teams/[id]/members/route.ts            |   16 +
 src/app/api/teams/route.ts                         |   11 +
 src/app/api/users/[id]/deactivate/route.ts         |   17 +
 src/app/api/users/[id]/role/route.ts               |   18 +
 src/app/api/users/[id]/route.ts                    |   35 +
 src/app/error.tsx                                  |   52 +
 src/app/globals.css                                |   14 +
 src/app/health/route.ts                            |   15 +
 src/app/layout.tsx                                 |   58 +
 src/app/manifest.ts                                |   24 +
 src/app/not-found.tsx                              |   19 +
 src/components/admin/approvals-admin.tsx           |  216 +
 src/components/admin/forbidden-state.tsx           |   19 +
 src/components/admin/page-header.tsx               |   10 +
 src/components/admin/settings-form.tsx             |  132 +
 src/components/admin/teams-admin.tsx               |  184 +
 src/components/admin/use-action.ts                 |   39 +
 src/components/admin/users-admin.tsx               |  344 +
 src/components/auth/auth-card.tsx                  |   26 +
 src/components/auth/field.tsx                      |   40 +
 src/components/auth/form-message.tsx               |   45 +
 src/components/auth/invite-accept.tsx              |  136 +
 src/components/auth/login-form.tsx                 |   89 +
 src/components/auth/mfa-form.tsx                   |   59 +
 src/components/auth/mfa-setup.tsx                  |  121 +
 src/components/auth/password-form.tsx              |   81 +
 src/components/auth/qr-code.tsx                    |   32 +
 src/components/auth/sign-out-button.tsx            |   22 +
 src/components/auth/tenant-picker.tsx              |   52 +
 src/components/auth/turnstile-widget.tsx           |   77 +
 src/components/shell/app-nav.tsx                   |   71 +
 src/components/shell/empty-state.tsx               |   33 +
 src/components/shell/install-prompt.tsx            |   36 +
 src/components/shell/screen.tsx                    |   18 +
 src/config/product.ts                              |   13 +
 src/db/client.ts                                   |   27 +
 src/db/env.ts                                      |   14 +
 src/db/schema/README.md                            |    7 +
 src/i18n/config.ts                                 |   23 +
 src/i18n/global.d.ts                               |   10 +
 src/i18n/request.ts                                |   22 +
 src/instrumentation.ts                             |   33 +
 src/lib/api-error-codes.ts                         |   31 +
 src/lib/api-error.ts                               |   26 +
 src/lib/api-problem.ts                             |   21 +
 src/lib/auth-policy.ts                             |    6 +
 src/lib/feature-flags.ts                           |   23 +
 src/lib/log.ts                                     |    8 +
 src/lib/post-json.ts                               |   52 +
 src/lib/request-id.ts                              |    9 +
 src/lib/version.ts                                 |    6 +
 src/proxy.ts                                       |   89 +
 src/server/README.md                               |   18 +
 src/server/ai/README.md                            |    5 +
 src/server/alerts/adapter.ts                       |   85 +
 src/server/alerts/checks.ts                        |   89 +
 src/server/approvals/service.ts                    |  257 +
 src/server/auth/README.md                          |   19 +
 src/server/auth/audit.ts                           |   69 +
 src/server/auth/better-auth.ts                     |  339 +
 src/server/auth/context.ts                         |   32 +
 src/server/auth/invitations.ts                     |  413 +
 src/server/auth/memberships.ts                     |   48 +
 src/server/auth/permissions.ts                     |   69 +
 src/server/auth/scope.ts                           |   57 +
 src/server/auth/session.ts                         |   37 +
 src/server/auth/with-tenant.ts                     |  263 +
 src/server/billing/README.md                       |    4 +
 src/server/crypto/blind-index.ts                   |   15 +
 src/server/crypto/envelope.ts                      |   47 +
 src/server/crypto/keyring.ts                       |   66 +
 src/server/crypto/subject-keys.ts                  |  184 +
 src/server/customers/repository.ts                 |  272 +
 src/server/customers/service.ts                    |   60 +
 src/server/events.ts                               |   33 +
 src/server/fx/README.md                            |    5 +
 src/server/health.ts                               |   49 +
 src/server/jobs/clock.ts                           |   40 +
 src/server/jobs/handlers.ts                        |   14 +
 src/server/jobs/health.ts                          |   25 +
 src/server/jobs/mail-dispatch.ts                   |   33 +
 src/server/jobs/ops.ts                             |  112 +
 src/server/jobs/outbox.ts                          |  146 +
 src/server/jobs/retention.ts                       |   46 +
 src/server/jobs/schedule.ts                        |   78 +
 src/server/jobs/tenant-job.ts                      |   43 +
 src/server/jobs/worker.ts                          |  148 +
 src/server/mail/adapter.ts                         |  154 +
 src/server/mail/auth-mailer.ts                     |   50 +
 src/server/mail/crypto.ts                          |   52 +
 src/server/observability/scrub.ts                  |  106 +
 src/server/observability/sentry.ts                 |   90 +
 src/server/permissions/matrix.ts                   |   95 +
 src/server/security/headers.ts                     |   69 +
 src/server/security/rate-limit.ts                  |   38 +
 src/server/security/turnstile.ts                   |   81 +
 src/server/settings/service.ts                     |  120 +
 src/server/sharing/README.md                       |    4 +
 src/server/teams/service.ts                        |  216 +
 src/server/users/service.ts                        |  331 +
 src/styles/theme-colors.ts                         |    7 +
 src/styles/tokens.css                              |   32 +
 src/types/qrcode.d.ts                              |   13 +
 tailwind.config.ts                                 |   50 +
 tests/e2e/admin-users.spec.ts                      |  118 +
 tests/e2e/auth-screens.spec.ts                     |   57 +
 tests/e2e/auth.setup.ts                            |   80 +
 tests/e2e/e2e-env.ts                               |   57 +
 tests/e2e/global-setup.ts                          |  130 +
 tests/e2e/health.spec.ts                           |   15 +
 tests/e2e/password.spec.ts                         |   17 +
 tests/e2e/shell.spec.ts                            |   55 +
 tests/e2e/sink.ts                                  |   29 +
 tests/golden/api-routes.test.ts                    |  158 +
 tests/golden/db/admin.test.ts                      |  415 +
 tests/golden/db/audit-log.test.ts                  |   88 +
 tests/golden/db/auth-client.ts                     |   65 +
 tests/golden/db/auth.test.ts                       |  446 +
 tests/golden/db/backup.test.ts                     |   79 +
 tests/golden/db/captcha.test.ts                    |  159 +
 tests/golden/db/customers.test.ts                  |  202 +
 tests/golden/db/encryption.test.ts                 |  189 +
 tests/golden/db/feature-flags.test.ts              |   60 +
 .../golden/db/find-or-create-legal-entity.test.ts  |   86 +
 tests/golden/db/fixtures.ts                        |  145 +
 tests/golden/db/governance.test.ts                 |  175 +
 tests/golden/db/helpers.ts                         |   99 +
 tests/golden/db/invitations.test.ts                |  503 +
 tests/golden/db/permissions-catalog.test.ts        |   27 +
 tests/golden/db/pii-registry.test.ts               |  115 +
 tests/golden/db/rls.test.ts                        |  166 +
 tests/golden/db/sharing.test.ts                    |  215 +
 tests/golden/db/teams-scope.test.ts                |  374 +
 tests/golden/db/tenant-api.test.ts                 |  520 ++
 tests/golden/db/worker.test.ts                     |  443 +
 tests/golden/permissions-matrix.test.ts            |  113 +
 tests/golden/rls-coverage.test.ts                  |  113 +
 tests/golden/scope-usage.test.ts                   |   38 +
 tests/smoke/health.test.ts                         |   52 +
 tests/unit/alerts.test.ts                          |  104 +
 tests/unit/api-error.test.ts                       |   21 +
 tests/unit/auth-config.test.ts                     |   86 +
 tests/unit/crypto.test.ts                          |   73 +
 tests/unit/messages.test.ts                        |   27 +
 tests/unit/observability.test.ts                   |   60 +
 tests/unit/schedule.test.ts                        |   69 +
 tests/unit/security.test.ts                        |  174 +
 tests/unit/tokens.test.ts                          |   18 +
 tests/unit/wireframes.test.ts                      |   66 +
 tsconfig.json                                      |   36 +
 vitest.config.ts                                   |   15 +
 vitest.db.config.ts                                |   17 +
 267 files changed, 31657 insertions(+)
```
