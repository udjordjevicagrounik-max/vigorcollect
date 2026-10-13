# Changelog

Generisano iz conventional commit-a: `scripts/release.sh changelog <x.y.z>`.

## 0.1.0 — 2026-10-13

### Novo

- add migration 001 identity, tenant and governance
- add migration 002 customers, contacts and subject keys
- add migration 003 sharing and governance
- add migration 004 permissions catalog
- add migration 005 auth schema and Better Auth configuration
- add migration 006 invitations and mail outbox, tenant helpers and auth hardening
- add migration 011 team keys and backup role grants, worker image and roles in compose
- add migrations 007 worker and 008 api rate limit, tenant page helper, worker service
- add migrations 009 teams and 010 ops runs, scope filter and ops env in compose
- admin users, tenant settings, system status and permission-based shell (1.5)
- cases, promises, activities, payments and legal handover (2.4) (collections)
- collection mail, pdf documents, rule proposals to approval, daily run (3.3) (collections)
- configurable, versioned and explainable rule engine (3.1) (rules)
- connect n8n for sinergista; hmac through the crypto node and credential (integrations)
- continue fallback after sign-in and verification code when navigation does not happen
- customer list, customer 360 and dashboard (2.3) (receivables)
- customers, contacts and PII encryption (schema v1, 0.2b)
- disputes, global search and bulk actions (5.1) (receivables)
- explained risk scores, risk providers and credit status proposals (4.3) (risk)
- exports, six reports, settings and digests (5.2) (reports)
- getting started checklist, i18n pass and sprint 5 e2e (5.4) (onboarding)
- integration framework, api keys, signed webhooks and outbound for n8n (4.1) (integrations)
- integrations, mail inbox and risk (018-020); api keys in withTenant (sprint 4) (db)
- invitations, mail sink and dev admin password script (1.1b)
- invoice import wizard, worker apply and rollback (2.2) (import)
- mail kinds, pdf renditions (017); documents volume and chromium worker (sprint 3.3) (db)
- mail_outbox kind test for the integration test message (023) (db)
- mailbox onboarding form and microsoft 365 consent (5.3) (integrations)
- money helper, fx rates job and receivables golden tests (2.1) (fx)
- outbox worker, tenant-local daily jobs, retention and job health (1.3)
- payment kinds, workflows, templates and documents migrations 015-016 (sprint 3) (db)
- permission matrix, system roles and catalog golden tests (0.3a)
- receivables, imports and reporting migrations 012-014 (sprint 2) (db)
- received mail, threading, replies and delivery through the mailbox integration (4.2) (mail)
- renderer queue (021) and security fixes (022); compose services; auth (session 5.0) (db)
- report builder with datasets, own svg charts and drill-down (6.2) (reporting)
- schema v1 identity, tenant and governance tables
- security headers, csrf, zod gate, api rate limit, turnstile and error shape (1.4)
- send a test message through the mailbox integration; n8n smtp sender (integrations)
- sentry, alarms, backup and restore test, smoke script and ops status (1.7)
- sharing and governance schema support (schema v1, 0.2c)
- sign-in tests, auth route, seed identities and ADR 0004 (1.1a)
- sign-in, MFA setup, invitation, password and tenant screens (1.1c)
- sprint 5 migrations 024-026 and worker/app env (protected) (db)
- teams, scope filter on customers, approvals screen and role matrix maker-checker (1.6)
- templates, documents, export links and attention (3.2) (communication)
- tenant API routes and golden tests for withTenant, permissions and audit (1.2)
- tenant fields on customers, contacts, invoices and cases (6.1) (custom-fields)
- tenants, trial and sandbox, public signup, data package, libraries (6.4) (platform)
- widget dashboards with home per member and role (6.3) (dashboards)

### Ispravke

- /health aggregates from a function the worker owns (review s-05) (worker)
- /health sees the render loop across next module instances (review s-10) (renderer)
- adjustments are not collections; edge-safe instrumentation (2.5) (receivables)
- claim before the post, idempotency-key, per-item transactions (review s-09) (integrations)
- client ip from the trusted end of x-forwarded-for (review s-07) (security)
- credentials out of reach inside tenant transactions; active tenant checked (review s-03) (auth)
- keep the storage adapter out of build tracing (no build warning) (documents)
- natural persons are never imported as companies (review s-02) (imports)
- read legal entities only through legal_entities_public (review s-01) (parties)
- renderer without secrets, migrate as one-shot, encrypted backups (review s-04/s-10/s-11) (ops)
- second administrator for privileged roles, team leads, org api keys (review s-06) (governance)
- xlsx column cap and linear scanner (review s-12) (imports)

### Performanse

- staging guide, release tools, pseudonymizer, 1000/20000 check under 1 s (6.5)

### Dokumentacija

- clickable wireframes for Sprint 1/2 and Sprint 0 close-out (0.3b)
- fix merge commit types in the runbook git flow
- github remote and deploy key, what to do when the container is recreated (runbook)
- host copy from the worker volume, weekly restore test with the age key (runbook)
- host copy of backups (cron 03:30, /opt/app/backups, 30 days) (runbook)
- monday check after elestio watchtower; borg covers /opt/app/backups (off-site candidate)
- off-site decided (borgbase daily, b2/hetzner monthly), host copy encrypted only
- preview proxy copy, runbook preview section and turnstile sharing risk
- regenerate security review input after session 5.0
- review follow-ups in backlog, three new checklist areas, generated review input
- security review 2026-10-13 (develop c1bd4c2, 59 findings, 0 p1 / 12 p2)
- session 5.0 closed — security fixes, assumptions, manual deploy steps
- sprint 2 status, assumptions and next steps in NEXT.md
- sprint 3 closed — 3.3 status, assumptions, runbook, adr 0003 check replacement
- sprint 3 night chain status, assumptions and pending decisions in NEXT.md
- sprint 4 closed — status, assumptions, runbook, adr 0003 check replacements

### Ostalo

- add project CLAUDE.md
- add protected infrastructure files
- bootstrap application skeleton
- close sprint 1 - worker image tools, backup service roles, team keys, git flow
- membership bridge policy is pre-tenant only (1.1a review)
- migrate.sh test runs on an isolated copy and can never reach a database (ops)
- pick the legal handover proposal when risk also proposes a credit status (e2e)
