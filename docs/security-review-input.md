# Ulaz za security review (odvojena sesija)

_Generisano skriptom `scripts/security-review-input.sh` (2026-10-13) — ne menjati ručno;
pre review-a pokrenuti ponovo da opseg odgovara grani._

- **Opseg:** `git diff c1bd4c2..092f7bf` (HEAD; 10 commit-a).
- **Ukupno:** 93 files changed, 3811 insertions(+), 537 deletions(-)
- **Prethodni review:** docs/security-review-2026-10-13.md
- **Checklist:** `docs/security-review-checklist.md`; pravila: `CLAUDE.md` (NON-NEGOTIABLE).
- **Kako:** odvojena sesija dobija samo ovaj opseg, `CLAUDE.md` i checklist; `docs/NEXT.md` i
  ADR-ovi se čitaju tek posle nalaza.

## Izmenjeni fajlovi po oblasti

| oblast                               | fajlova |
| ------------------------------------ | ------- |
| `.env.example`                       | 1       |
| `.semgrep.yml`                       | 1       |
| `Dockerfile`                         | 1       |
| `docs/adr`                           | 2       |
| `docs/integrations`                  | 2       |
| `docs/permissions.md`                | 1       |
| `docs/runbook.md`                    | 1       |
| `docs/security-review-2026-10-13.md` | 1       |
| `messages`                           | 2       |
| `playwright.config.ts`               | 1       |
| `scripts/backup.sh`                  | 1       |
| `scripts/copy-standalone-assets.mjs` | 1       |
| `scripts/create-service-roles.sh`    | 1       |
| `scripts/demo-import`                | 2       |
| `scripts/migrate.sh`                 | 1       |
| `scripts/renderer-entry.mjs`         | 1       |
| `scripts/restore-test.sh`            | 1       |
| `scripts/setup-tools.sh`             | 1       |
| `src/app/(app)`                      | 1       |
| `src/app/api`                        | 4       |
| `src/app/health`                     | 1       |
| `src/components/admin`               | 5       |
| `src/components/import`              | 2       |
| `src/db/client.ts`                   | 1       |
| `src/db/env.ts`                      | 1       |
| `src/server/approvals`               | 1       |
| `src/server/collections`             | 1       |
| `src/server/customers`               | 1       |
| `src/server/documents`               | 4       |
| `src/server/governance`              | 1       |
| `src/server/imports`                 | 5       |
| `src/server/integrations`            | 2       |
| `src/server/jobs`                    | 6       |
| `src/server/mail`                    | 1       |
| `src/server/receivables`             | 1       |
| `src/server/risk`                    | 2       |
| `src/server/security`                | 2       |
| `src/server/teams`                   | 1       |
| `src/server/templates`               | 1       |
| `src/server/users`                   | 1       |
| `src/server/workflows`               | 1       |
| `src`                                | 2       |
| `tests/golden`                       | 18      |
| `tests/unit`                         | 5       |

## Zaštićeni fajlovi (pravilo 13) u opsegu

- nema

## Migracije u opsegu

- nema

## ADR-ovi izmenjeni u opsegu

- `docs/adr/0002-canonical-party-model.md` — 0002 — Kanonski model stranaka, tenant osnova i governance (Schema v1, 0.2a)
- `docs/adr/0004-auth.md` — 0004 — Autentifikacija: Better Auth u šemi `auth`, lozinka + TOTP, sesija vezana za tenant

## `git diff c1bd4c2..092f7bf --stat`

```text
 .env.example                                        |  18 +++++++--
 .semgrep.yml                                        |   4 +-
 Dockerfile                                          |  19 +++++----
 docs/adr/0002-canonical-party-model.md              |  29 ++++++++++++++
 docs/adr/0004-auth.md                               |  21 ++++++++++
 docs/integrations/n8n.md                            |   7 ++++
 docs/integrations/n8n/mail-outbound.json            |  83 ++++++++++++++++++++++++++++++++++++--
 docs/permissions.md                                 |  46 +++++++++++++--------
 docs/runbook.md                                     |  89 +++++++++++++++++++++++++++++++----------
 docs/security-review-2026-10-13.md                  | 190 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 messages/en.json                                    |  39 ++++++++++++++----
 messages/sr-Latn.json                               |  39 ++++++++++++++----
 playwright.config.ts                                |   5 +--
 scripts/backup.sh                                   |  22 +++++++---
 scripts/copy-standalone-assets.mjs                  |   9 ++++-
 scripts/create-service-roles.sh                     |   9 ++++-
 scripts/demo-import/fakture-demo.csv                |  82 +++++++++++++++++++-------------------
 scripts/demo-import/generate.ts                     |   6 ++-
 scripts/migrate.sh                                  |  14 +++++--
 scripts/renderer-entry.mjs                          |   7 ++++
 scripts/restore-test.sh                             |  44 ++++++++++++++------
 scripts/setup-tools.sh                              |  11 ++++-
 src/app/(app)/import/page.tsx                       |   5 +++
 src/app/api/approvals/[id]/decision/route.ts        |  10 ++++-
 src/app/api/invitations/accept/route.ts             |   3 +-
 src/app/api/invitations/route.ts                    |   4 +-
 src/app/api/teams/[id]/lead/route.ts                |   7 ++--
 src/app/health/route.ts                             |   9 +++++
 src/components/admin/approvals-admin.tsx            |  11 +++++
 src/components/admin/integrations-admin.tsx         |  33 ++++++++++++---
 src/components/admin/teams-admin.tsx                |   3 +-
 src/components/admin/use-action.ts                  |   9 +++--
 src/components/admin/users-admin.tsx                |   4 +-
 src/components/import/import-wizard.tsx             |   1 +
 src/components/import/suspicious-parties.tsx        |  36 +++++++++++++++++
 src/db/client.ts                                    |   7 ----
 src/db/env.ts                                       |   5 ++-
 src/instrumentation-node.ts                         |   8 ++++
 src/proxy.ts                                        |  14 ++++---
 src/server/approvals/service.ts                     |  37 ++++++++++++++++-
 src/server/collections/service.ts                   |   6 +--
 src/server/customers/repository.ts                  |  55 +++++++++++++++++++------
 src/server/documents/pdf.ts                         |  13 +++---
 src/server/documents/render-queue.ts                | 102 +++++++++++++++++++++++++++++++++++++++++++++++
 src/server/documents/renderer.ts                    |  91 ++++++++++++++++++++++++++++++++++++++++++
 src/server/documents/service.ts                     |  15 +++++--
 src/server/governance/four-eyes.ts                  | 156 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 src/server/imports/party.ts                         |  61 ++++++++++++++++++++++++++++
 src/server/imports/process.ts                       | 106 +++++++++++++++++++++++++++++++++++++++++--------
 src/server/imports/rows.ts                          |  23 +++++++++++
 src/server/imports/suspicious.ts                    |  48 ++++++++++++++++++++++
 src/server/imports/xlsx.ts                          |  72 ++++++++++++++++++++++++++-------
 src/server/integrations/api-keys.ts                 | 125 +++++++++++++++++++++++++++++++++++++++++++++++++++------
 src/server/integrations/outbound.ts                 | 208 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++-------------------------------
 src/server/jobs/handlers.ts                         |  25 ++++++------
 src/server/jobs/health.ts                           |  23 +++++++----
 src/server/jobs/ops.ts                              |  23 ++++++-----
 src/server/jobs/retention.ts                        |   8 +++-
 src/server/jobs/tenant-job.ts                       |  18 +++++++++
 src/server/jobs/worker.ts                           |  58 +++++++++++++++++++--------
 src/server/mail/dispatch-integration.ts             | 259 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++--------------------------------------------
 src/server/receivables/service.ts                   |   8 ++--
 src/server/risk/internal.ts                         |   2 +-
 src/server/risk/service.ts                          |   2 +-
 src/server/security/client-ip.ts                    |  53 +++++++++++++++++++++++++
 src/server/security/turnstile.ts                    |   7 ----
 src/server/teams/service.ts                         |  64 ++++++++++++++++++++++++++----
 src/server/templates/service.ts                     |   4 +-
 src/server/users/service.ts                         |  18 +++++----
 src/server/workflows/engine.ts                      |   4 +-
 tests/golden/db/admin.test.ts                       |  26 ++++++++++--
 tests/golden/db/auth-client.ts                      |   4 +-
 tests/golden/db/auth-isolation.test.ts              | 148 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/golden/db/auth.test.ts                        |   2 +-
 tests/golden/db/backup.test.ts                      |  84 +++++++++++++++++++++++++++++++++++----
 tests/golden/db/captcha.test.ts                     |   2 +-
 tests/golden/db/dispatch-once.test.ts               | 243 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/golden/db/find-or-create-legal-entity.test.ts |  78 +++++++++++++++++++++++++++++++++++-
 tests/golden/db/four-eyes.test.ts                   | 306 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/golden/db/import-parties.test.ts              | 160 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/golden/db/imports.test.ts                     |  39 +++++++++---------
 tests/golden/db/integrations.test.ts                |  11 ++---
 tests/golden/db/invitations.test.ts                 |   4 +-
 tests/golden/db/mail-inbox.test.ts                  |   3 +-
 tests/golden/db/renderer.test.ts                    | 206 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/golden/db/teams-scope.test.ts                 |  37 +++++++++++++++--
 tests/golden/db/worker.test.ts                      |  38 ++++++++++++++++++
 tests/golden/legal-entities-reads.test.ts           |  27 +++++++++++++
 tests/unit/auth-config.test.ts                      |  20 +++++++++-
 tests/unit/containers.test.ts                       | 134 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 tests/unit/fixtures/xlsx-builder.ts                 |   8 +++-
 tests/unit/imports.test.ts                          |  61 ++++++++++++++++++++++++++++
 tests/unit/security.test.ts                         |  51 ++++++++++++++++++++++++
 93 files changed, 3811 insertions(+), 537 deletions(-)
```
